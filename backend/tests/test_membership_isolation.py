"""Membership isolation — the worst bug this project could ship.

Every read and write resolves its target to a board and asserts the caller is a
member of it. A card id and a comment id are each authorized through their
board, never through their parent alone, and every failure is **404, never
403** — board membership must not be discoverable by probing ids.

Mallory is signed in and a member of nothing. Every endpoint must treat her
exactly as it treats a request for an id that does not exist.
"""

import pytest


@pytest.fixture
async def populated(alice, board):
    """A board owned by Alice with a list, a card and a comment on it."""
    board_id = board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    card = (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Secret"})).json()
    comment = (
        await alice.post("/api/cards/{}/comments".format(card["id"]), {"body": "Confidential"})
    ).json()
    return {"board_id": board_id, "list": doing, "card": card, "comment": comment}


async def test_non_member_gets_404_from_every_read(mallory, populated):
    board_id = populated["board_id"]
    card_id = populated["card"]["id"]

    assert (await mallory.get("/api/boards/{}".format(board_id))).status_code == 404
    assert (await mallory.get("/api/boards/{}/activity".format(board_id))).status_code == 404
    assert (await mallory.get("/api/cards/{}/comments".format(card_id))).status_code == 404


async def test_non_member_gets_404_from_every_write(mallory, populated):
    board_id = populated["board_id"]
    list_id = populated["list"]["id"]
    card_id = populated["card"]["id"]
    comment_id = populated["comment"]["id"]

    checks = [
        await mallory.patch("/api/boards/{}".format(board_id), {"title": "Mine now"}),
        await mallory.delete("/api/boards/{}".format(board_id)),
        await mallory.post(
            "/api/boards/{}/members".format(board_id), {"email": "x@example.com"}
        ),
        await mallory.post("/api/boards/{}/lists".format(board_id), {"title": "Intrusion"}),
        await mallory.patch("/api/lists/{}".format(list_id), {"title": "Renamed"}),
        await mallory.patch(
            "/api/lists/{}/move".format(list_id),
            {"before_list_id": None, "after_list_id": None},
        ),
        await mallory.delete("/api/lists/{}".format(list_id)),
        await mallory.post("/api/lists/{}/cards".format(list_id), {"title": "Intrusion"}),
        await mallory.patch("/api/cards/{}".format(card_id), {"title": "Renamed"}),
        await mallory.patch(
            "/api/cards/{}/move".format(card_id),
            {"list_id": list_id, "before_card_id": None, "after_card_id": None},
        ),
        await mallory.delete("/api/cards/{}".format(card_id)),
        await mallory.post("/api/cards/{}/comments".format(card_id), {"body": "hello"}),
        await mallory.delete("/api/comments/{}".format(comment_id)),
        await mallory.post("/api/realtime/ticket", {"board_id": board_id}),
    ]

    for response in checks:
        assert response.status_code == 404, "{} {} returned {}".format(
            response.request.method, response.request.url.path, response.status_code
        )
        assert "detail" not in response.json()


async def test_probing_reveals_nothing(mallory, populated):
    """A board that exists and one that does not must be indistinguishable."""
    real = await mallory.get("/api/boards/{}".format(populated["board_id"]))
    imaginary = await mallory.get("/api/boards/999999")
    assert real.status_code == imaginary.status_code == 404
    assert real.json() == imaginary.json() == {"error": "Board not found."}


async def test_nothing_was_actually_changed(alice, mallory, populated):
    """The 404s above must be refusals, not silent successes."""
    board_id = populated["board_id"]
    await mallory.patch("/api/cards/{}".format(populated["card"]["id"]), {"title": "Renamed"})
    await mallory.delete("/api/lists/{}".format(populated["list"]["id"]))

    snapshot = (await alice.get("/api/boards/{}".format(board_id))).json()
    assert len(snapshot["lists"]) == 1
    assert snapshot["lists"][0]["cards"][0]["title"] == "Secret"


async def test_cross_board_card_access_is_404(alice, bob, board, populated):
    """Bob owns his own board; that does not let him touch Alice's cards."""
    await bob.post("/api/boards", {"title": "Bob's board"})
    response = await bob.patch(
        "/api/cards/{}".format(populated["card"]["id"]), {"title": "Renamed"}
    )
    assert response.status_code == 404
    assert response.json() == {"error": "Card not found."}


async def test_a_card_cannot_be_moved_into_another_boards_list(alice, bob, populated):
    """Authorization is through the board, not through the parent list alone."""
    bob_board = (await bob.post("/api/boards", {"title": "Bob's board"})).json()
    bob_list = (
        await bob.post("/api/boards/{}/lists".format(bob_board["id"]), {"title": "Bob's list"})
    ).json()

    response = await alice.patch(
        "/api/cards/{}/move".format(populated["card"]["id"]),
        {"list_id": bob_list["id"], "before_card_id": None, "after_card_id": None},
    )
    assert response.status_code == 422
    assert response.json() == {"error": "Cards cannot be moved to another board."}


async def test_comments_are_deletable_only_by_their_author(bob, alice, shared_board):
    """Someone else's comment gets the same 404 as a missing one."""
    board_id = shared_board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    card = (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Card"})).json()
    comment = (
        await alice.post("/api/cards/{}/comments".format(card["id"]), {"body": "Alice's"})
    ).json()

    # Bob is a member and can read it, but cannot delete it.
    assert (await bob.get("/api/cards/{}/comments".format(card["id"]))).status_code == 200
    response = await bob.delete("/api/comments/{}".format(comment["id"]))
    assert response.status_code == 404
    assert response.json() == {"error": "Comment not found."}

    still_there = (await alice.get("/api/cards/{}/comments".format(card["id"]))).json()
    assert len(still_there["comments"]) == 1


async def test_every_endpoint_requires_authentication(client, populated):
    board_id = populated["board_id"]
    unauthenticated = [
        await client.get("/api/boards"),
        await client.post("/api/boards", json={"title": "x"}),
        await client.get("/api/boards/{}".format(board_id)),
        await client.get("/api/boards/{}/activity".format(board_id)),
        await client.post("/api/realtime/ticket", json={"board_id": board_id}),
        await client.get("/api/cards/{}/comments".format(populated["card"]["id"])),
    ]
    for response in unauthenticated:
        assert response.status_code == 401
        assert response.json() == {"error": "Not authenticated."}
