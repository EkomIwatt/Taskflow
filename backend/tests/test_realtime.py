"""The WebSocket protocol — Contract 6, and the echo semantics of Contract 7."""

import asyncio

import pytest

from app.realtime import hub
from tests.conftest import TEST_ORIGIN, WebSocketClosed


def assert_envelope(frame: dict, event_type: str, board_id: int) -> None:
    """Contract 6 §2: every field is always present on every frame."""
    assert set(frame) == {
        "type",
        "board_id",
        "seq",
        "actor_id",
        "client_op_id",
        "ts",
        "payload",
    }
    assert frame["type"] == event_type
    assert frame["board_id"] == board_id
    assert frame["ts"].endswith("Z")
    assert isinstance(frame["payload"], dict)


# ---------------------------------------------------------------------------
# §1 — the ticket
# ---------------------------------------------------------------------------


async def test_ticket_shape(alice, board):
    response = await alice.post("/api/realtime/ticket", {"board_id": board["id"]})
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"ticket", "expires_in"}
    assert body["expires_in"] == 30
    assert isinstance(body["ticket"], str) and body["ticket"]


async def test_ticket_for_someone_elses_board_is_404(mallory, board):
    response = await mallory.post("/api/realtime/ticket", {"board_id": board["id"]})
    assert response.status_code == 404
    assert response.json() == {"error": "Board not found."}


async def test_ticket_requires_authentication(client, board):
    response = await client.post("/api/realtime/ticket", json={"board_id": board["id"]})
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# §3 — hello, and the close codes of §5
# ---------------------------------------------------------------------------


async def test_hello_is_the_first_frame_and_carries_the_seq(
    alice, board, open_socket, ticket_for
):
    snapshot = (await alice.get("/api/boards/{}".format(board["id"]))).json()
    ticket = await ticket_for(alice, board["id"])

    socket = await open_socket(board["id"], ticket, expect_hello=False)
    frame = await socket.receive_json()

    assert_envelope(frame, "hello", board["id"])
    assert frame["seq"] == snapshot["seq"]
    payload = frame["payload"]
    assert payload["board_id"] == board["id"]
    assert payload["seq"] == snapshot["seq"]
    assert payload["you"]["id"] == alice.id
    assert [u["id"] for u in payload["online"]] == [alice.id]


async def test_invalid_ticket_closes_4001(board, open_socket):
    socket = await open_socket(board["id"], "not-a-real-ticket", expect_hello=False)
    assert await socket.expect_close() == 4001


async def test_missing_ticket_closes_4001(board, open_socket):
    socket = await open_socket(board["id"], None, expect_hello=False)
    assert await socket.expect_close() == 4001


async def test_reused_ticket_closes_4001(alice, board, open_socket, ticket_for):
    """A ticket is single-use: the replay must not open a second socket."""
    ticket = await ticket_for(alice, board["id"])

    first = await open_socket(board["id"], ticket)
    assert first.accepted

    second = await open_socket(board["id"], ticket, expect_hello=False)
    assert await second.expect_close() == 4001


async def test_ticket_is_bound_to_its_board(alice, board, open_socket, ticket_for):
    other = (await alice.post("/api/boards", {"title": "Other"})).json()
    ticket = await ticket_for(alice, board["id"])

    socket = await open_socket(other["id"], ticket, expect_hello=False)
    assert await socket.expect_close() == 4001


async def test_non_member_cannot_open_a_socket(alice, mallory, board, open_socket):
    """Mallory has no ticket route in; forging one still fails at connect time."""
    ticket = hub.mint_ticket(mallory.id, board["id"], 30)
    socket = await open_socket(board["id"], ticket, expect_hello=False)
    assert await socket.expect_close() == 4003


async def test_unknown_board_closes_4004(alice, open_socket):
    ticket = hub.mint_ticket(alice.id, 987654, 30)
    socket = await open_socket(987654, ticket, expect_hello=False)
    assert await socket.expect_close() == 4004


async def test_ticket_minted_before_removal_cannot_open_a_socket(
    alice, bob, shared_board, open_socket, ticket_for
):
    """Membership is re-checked at connect time, not only at ticket time."""
    ticket = await ticket_for(bob, shared_board["id"])
    removed = await alice.delete(
        "/api/boards/{}/members/{}".format(shared_board["id"], bob.id)
    )
    assert removed.status_code == 204

    socket = await open_socket(shared_board["id"], ticket, expect_hello=False)
    assert await socket.expect_close() == 4003


async def test_disallowed_origin_is_rejected_at_the_handshake(
    alice, board, open_socket, ticket_for
):
    """Browsers do not apply same-origin policy to WebSockets, so this is checked
    by hand — and it is refused before the socket is ever accepted."""
    ticket = await ticket_for(alice, board["id"])
    socket = await open_socket(
        board["id"], ticket, origin="https://evil.example", expect_hello=False
    )
    assert not socket.accepted
    assert socket.close_code == 1008


async def test_allowed_origin_connects(alice, board, open_socket, ticket_for):
    ticket = await ticket_for(alice, board["id"])
    socket = await open_socket(board["id"], ticket, origin=TEST_ORIGIN, expect_hello=False)
    assert socket.accepted
    assert (await socket.receive_json())["type"] == "hello"


# ---------------------------------------------------------------------------
# §3 — state events reach the other clients
# ---------------------------------------------------------------------------


async def test_a_mutation_by_a_reaches_b(alice, bob, shared_board, open_socket, ticket_for):
    board_id = shared_board["id"]
    socket_b = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket_b.drain()

    response = await alice.post(
        "/api/boards/{}/lists".format(board_id), {"title": "Doing", "after_list_id": None}
    )
    assert response.status_code == 201
    created = response.json()

    frame = await socket_b.receive_until("list.created")
    assert_envelope(frame, "list.created", board_id)
    assert frame["actor_id"] == alice.id
    # Field-for-field with the HTTP body — one serializer builds both.
    assert frame["payload"] == created


async def test_card_moved_payload_matches_the_contract(
    alice, bob, shared_board, open_socket, ticket_for
):
    board_id = shared_board["id"]
    doing = (
        await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})
    ).json()
    done = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Done"})).json()
    card = (
        await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Fix login"})
    ).json()

    socket_b = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket_b.drain()

    response = await alice.patch(
        "/api/cards/{}/move".format(card["id"]),
        {"list_id": done["id"], "before_card_id": None, "after_card_id": None},
    )
    assert response.status_code == 200

    frame = await socket_b.receive_until("card.moved")
    assert set(frame["payload"]) == {
        "id",
        "list_id",
        "from_list_id",
        "order_key",
        "updated_at",
    }
    assert frame["payload"]["id"] == card["id"]
    assert frame["payload"]["list_id"] == done["id"]
    assert frame["payload"]["from_list_id"] == doing["id"]
    assert frame["payload"]["order_key"] == response.json()["order_key"]


async def test_activity_appended_accompanies_the_state_event(
    alice, bob, shared_board, open_socket, ticket_for
):
    board_id = shared_board["id"]
    socket_b = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket_b.drain()

    await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})

    frames = await socket_b.drain(timeout=0.3)
    types = [f["type"] for f in frames]
    assert types == ["list.created", "activity.appended"]
    # Contiguous seqs, in order.
    assert frames[1]["seq"] == frames[0]["seq"] + 1
    assert frames[1]["payload"]["verb"] == "list.created"
    assert frames[1]["payload"]["summary"] == "Alice added list Doing"


# ---------------------------------------------------------------------------
# Contract 7 §1 — the echo
# ---------------------------------------------------------------------------


async def test_client_op_id_is_echoed_verbatim_to_everyone_including_the_sender(
    alice, bob, shared_board, open_socket, ticket_for
):
    board_id = shared_board["id"]
    socket_a = await open_socket(board_id, await ticket_for(alice, board_id))
    socket_b = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket_a.drain()
    await socket_b.drain()

    await alice.post(
        "/api/boards/{}/lists".format(board_id), {"title": "Doing"}, client_op_id="abc"
    )

    own = await socket_a.receive_until("list.created")
    other = await socket_b.receive_until("list.created")
    # "The server does not skip the sender" — one code path, self-healing.
    assert own["client_op_id"] == "abc"
    assert other["client_op_id"] == "abc"
    assert own["payload"] == other["payload"]


async def test_client_op_id_is_null_when_not_supplied(
    alice, shared_board, open_socket, ticket_for
):
    board_id = shared_board["id"]
    socket = await open_socket(board_id, await ticket_for(alice, board_id))
    await socket.drain()

    await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})
    frame = await socket.receive_until("list.created")
    assert frame["client_op_id"] is None


async def test_broadcast_happens_after_commit(alice, bob, shared_board, open_socket, ticket_for):
    """On receiving an event, an immediate snapshot fetch already contains it."""
    board_id = shared_board["id"]
    socket_b = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket_b.drain()

    await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})
    frame = await socket_b.receive_until("list.created")

    snapshot = (await bob.get("/api/boards/{}".format(board_id))).json()
    assert [lst["id"] for lst in snapshot["lists"]] == [frame["payload"]["id"]]
    assert snapshot["seq"] >= frame["seq"]


# ---------------------------------------------------------------------------
# §4 — presence is ephemeral
# ---------------------------------------------------------------------------


async def test_presence_joined_and_left(alice, bob, shared_board, open_socket, ticket_for):
    board_id = shared_board["id"]
    socket_a = await open_socket(board_id, await ticket_for(alice, board_id))
    await socket_a.drain()

    socket_b = await open_socket(board_id, await ticket_for(bob, board_id))
    joined = await socket_a.receive_until("presence.joined")
    assert joined["seq"] is None, "presence must not advance the client's cursor"
    assert joined["payload"]["user"]["id"] == bob.id

    await socket_b.disconnect()
    left = await socket_a.receive_until("presence.left")
    assert left["seq"] is None
    assert left["payload"] == {"user_id": bob.id}


async def test_a_user_with_two_tabs_appears_once(
    alice, bob, shared_board, open_socket, ticket_for
):
    board_id = shared_board["id"]
    socket_a = await open_socket(board_id, await ticket_for(alice, board_id))
    await socket_a.drain()

    tab_one = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket_a.receive_until("presence.joined")

    tab_two = await open_socket(board_id, await ticket_for(bob, board_id))
    # The second tab is not a second arrival.
    await socket_a.expect_silence(timeout=0.15)
    assert sorted(hub.online_user_ids(board_id)) == sorted([alice.id, bob.id])
    assert hub.connection_count(board_id) == 3

    # presence.left only when the LAST connection for that board closes.
    await tab_one.disconnect()
    await socket_a.expect_silence(timeout=0.15)

    await tab_two.disconnect()
    left = await socket_a.receive_until("presence.left")
    assert left["payload"] == {"user_id": bob.id}


async def test_hello_online_lists_each_user_once(
    alice, bob, shared_board, open_socket, ticket_for
):
    board_id = shared_board["id"]
    await open_socket(board_id, await ticket_for(bob, board_id))
    await open_socket(board_id, await ticket_for(bob, board_id))

    socket_a = await open_socket(board_id, await ticket_for(alice, board_id), expect_hello=False)
    hello = await socket_a.receive_json()
    online_ids = [u["id"] for u in hello["payload"]["online"]]
    assert sorted(online_ids) == sorted([alice.id, bob.id])


async def test_disconnect_cleans_up_the_registry(alice, board, open_socket, ticket_for):
    socket = await open_socket(board["id"], await ticket_for(alice, board["id"]))
    assert hub.connection_count(board["id"]) == 1
    await socket.disconnect()
    await asyncio.sleep(0.05)
    assert hub.connection_count(board["id"]) == 0


async def test_removed_member_socket_is_closed_4003(
    alice, bob, shared_board, open_socket, ticket_for
):
    board_id = shared_board["id"]
    socket_b = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket_b.drain()

    await alice.delete("/api/boards/{}/members/{}".format(board_id, bob.id))

    # Contract 6 §3: the removed user is told, then disconnected.
    frames = []
    with pytest.raises(WebSocketClosed) as excinfo:
        for _ in range(6):
            frames.append(await socket_b.receive_json(timeout=1.0))
    assert excinfo.value.code == 4003
    assert "board.member_removed" in [f["type"] for f in frames]


# ---------------------------------------------------------------------------
# §4/§6 — heartbeat
# ---------------------------------------------------------------------------


async def test_server_pings_and_client_pongs(
    alice, board, open_socket, ticket_for, monkeypatch
):
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "ws_ping_interval_seconds", 0.05)

    socket = await open_socket(board["id"], await ticket_for(alice, board["id"]))
    ping = await socket.receive_until("ping", timeout=1.0)
    assert ping["seq"] is None
    assert ping["payload"] == {}

    await socket.send_json({"type": "pong"})
    # Still alive afterwards.
    assert (await socket.receive_until("ping", timeout=1.0))["type"] == "ping"


async def test_a_client_that_never_pongs_is_reaped(
    alice, board, open_socket, ticket_for, monkeypatch
):
    """A slept laptop's half-open socket must not leave a ghost in presence."""
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "ws_ping_interval_seconds", 0.05)

    board_id = board["id"]
    await open_socket(board_id, await ticket_for(alice, board_id))
    assert hub.online_user_ids(board_id) == [alice.id]

    # The client never replies to a ping; after three intervals it is dropped.
    await asyncio.sleep(0.45)
    assert hub.online_user_ids(board_id) == []
    assert hub.connection_count(board_id) == 0


# ---------------------------------------------------------------------------
# Broadcast-only: the client sends nothing but pong
# ---------------------------------------------------------------------------


async def test_unexpected_client_messages_are_ignored(
    alice, board, open_socket, ticket_for
):
    socket = await open_socket(board["id"], await ticket_for(alice, board["id"]))
    await socket.send_json({"type": "card.move", "payload": {"id": 1}})
    await socket.send_json({"nonsense": True})
    await socket._to_app.put({"type": "websocket.receive", "text": "not json at all"})

    await socket.expect_silence(timeout=0.15)
    # The socket is still usable.
    assert hub.connection_count(board["id"]) == 1


async def test_a_dead_client_does_not_block_the_broadcast(
    alice, bob, shared_board, open_socket, ticket_for, monkeypatch
):
    """One hung socket must not stall the board for everyone else."""
    board_id = shared_board["id"]
    socket_a = await open_socket(board_id, await ticket_for(alice, board_id))
    socket_b = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket_a.drain()
    await socket_b.drain()

    # Make Bob's socket hang on send, then tighten the broadcast timeout.
    bob_connection = next(c for c in hub.connections(board_id) if c.user_id == bob.id)

    async def hang(_payload):
        await asyncio.sleep(10)

    monkeypatch.setattr(bob_connection.websocket, "send_json", hang)
    monkeypatch.setattr(hub, "send_timeout", 0.1)

    await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})

    # Alice still gets her event, promptly.
    frame = await socket_a.receive_until("list.created", timeout=1.0)
    assert frame["payload"]["title"] == "Doing"
    # And the hung connection has been dropped.
    assert bob.id not in hub.online_user_ids(board_id)
