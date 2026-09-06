"""`seq` monotonicity and convergence under concurrency — Contract 6.

The role prompt is specific that this must be tested with concurrent requests
rather than by inspection, because the failure mode — two mutations handed the
same `seq` — only appears when they interleave.

What cannot be proven here is the two-browser convergence check: a fake client
can prove the server serialises two moves into two distinct keys, but not that
two real browsers end up rendering the same board. That is ★ check 4 at merge.
"""

import asyncio

from app.ordering import validate_order_key


async def test_concurrent_mutations_get_distinct_contiguous_seqs(alice, board):
    board_id = board["id"]
    start = (await alice.get("/api/boards/{}".format(board_id))).json()["seq"]

    responses = await asyncio.gather(
        *(
            alice.post("/api/boards/{}/lists".format(board_id), {"title": "List {}".format(n)})
            for n in range(8)
        )
    )
    assert all(r.status_code == 201 for r in responses)

    end = (await alice.get("/api/boards/{}".format(board_id))).json()["seq"]
    # Each mutation emits one state event plus one activity entry.
    assert end == start + 16


async def test_every_concurrent_mutation_broadcasts_exactly_once(
    alice, bob, shared_board, open_socket, ticket_for
):
    """N concurrent mutations produce N distinct, ordered, contiguous seqs."""
    board_id = shared_board["id"]
    socket = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket.drain()
    start = (await alice.get("/api/boards/{}".format(board_id))).json()["seq"]

    count = 8
    responses = await asyncio.gather(
        *(
            alice.post("/api/boards/{}/lists".format(board_id), {"title": "List {}".format(n)})
            for n in range(count)
        )
    )
    assert all(r.status_code == 201 for r in responses)

    frames = await socket.drain(timeout=0.5)
    assert len(frames) == count * 2, "one state event and one activity entry per mutation"

    seqs = [frame["seq"] for frame in frames]
    assert len(set(seqs)) == len(seqs), "two events shared a seq"
    assert seqs == sorted(seqs), "events were delivered out of seq order"
    assert seqs == list(range(start + 1, start + 1 + count * 2)), "seqs are not contiguous"

    created_ids = {frame["payload"]["id"] for frame in frames if frame["type"] == "list.created"}
    assert created_ids == {r.json()["id"] for r in responses}


async def test_concurrent_moves_into_the_same_gap_converge(alice, board):
    """The conflict case: two cards dropped into one gap at the same moment.

    Both must land, with distinct keys, and every client must agree on the
    resulting order. The server serialises them; neither card is lost and no
    position is duplicated.
    """
    board_id = board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    top = (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Top"})).json()
    bottom = (
        await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Bottom"})
    ).json()
    movers = [
        (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": t})).json()
        for t in ("Mover A", "Mover B")
    ]

    # Both dropped between the same two neighbours, concurrently.
    responses = await asyncio.gather(
        *(
            alice.patch(
                "/api/cards/{}/move".format(mover["id"]),
                {
                    "list_id": doing["id"],
                    "before_card_id": top["id"],
                    "after_card_id": bottom["id"],
                },
            )
            for mover in movers
        )
    )
    assert all(r.status_code == 200 for r in responses)

    snapshot = (await alice.get("/api/boards/{}".format(board_id))).json()
    cards = snapshot["lists"][0]["cards"]

    assert len(cards) == 4, "no card was lost or duplicated"
    keys = [c["order_key"] for c in cards]
    assert keys == sorted(keys)
    for key in keys:
        validate_order_key(key)

    # Both movers landed strictly between the two anchors.
    positions = {c["title"]: index for index, c in enumerate(cards)}
    assert positions["Top"] == 0
    assert positions["Bottom"] == 3
    assert {positions["Mover A"], positions["Mover B"]} == {1, 2}

    # And the ordering every client computes is the same one the server returned.
    resorted = sorted(cards, key=lambda c: (c["order_key"], c["id"]))
    assert [c["id"] for c in resorted] == [c["id"] for c in cards]


async def test_concurrent_edits_to_one_card_are_last_write_wins(alice, board):
    """Contract 7 §6: no merge, no CRDT — the second write wins and both
    clients converge because both receive both events in seq order."""
    board_id = board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    card = (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Original"})).json()

    responses = await asyncio.gather(
        *(
            alice.patch("/api/cards/{}".format(card["id"]), {"title": "Title {}".format(n)})
            for n in range(5)
        )
    )
    assert all(r.status_code == 200 for r in responses)

    snapshot = (await alice.get("/api/boards/{}".format(board_id))).json()
    final = snapshot["lists"][0]["cards"][0]["title"]
    assert final in {"Title {}".format(n) for n in range(5)}


async def test_seq_is_per_board_not_global(alice):
    """Two boards keep independent counters."""
    first = (await alice.post("/api/boards", {"title": "First"})).json()
    second = (await alice.post("/api/boards", {"title": "Second"})).json()

    for _ in range(3):
        await alice.post("/api/boards/{}/lists".format(first["id"]), {"title": "L"})

    first_seq = (await alice.get("/api/boards/{}".format(first["id"]))).json()["seq"]
    second_seq = (await alice.get("/api/boards/{}".format(second["id"]))).json()["seq"]
    assert first_seq == 7  # board.created + 3 * (list.created + activity)
    assert second_seq == 1  # board.created only


async def test_presence_does_not_advance_the_board_seq(
    alice, bob, shared_board, open_socket, ticket_for
):
    """Ephemeral events are never persisted and never touch the cursor."""
    board_id = shared_board["id"]
    socket_a = await open_socket(board_id, await ticket_for(alice, board_id))
    await socket_a.drain()
    before = (await alice.get("/api/boards/{}".format(board_id))).json()["seq"]

    socket_b = await open_socket(board_id, await ticket_for(bob, board_id))
    joined = await socket_a.receive_until("presence.joined")
    assert joined["seq"] is None

    await socket_b.disconnect()
    left = await socket_a.receive_until("presence.left")
    assert left["seq"] is None

    after = (await alice.get("/api/boards/{}".format(board_id))).json()["seq"]
    assert after == before
