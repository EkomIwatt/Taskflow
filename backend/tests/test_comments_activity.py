"""Comments and the activity feed — Contract 5."""

import pytest

from app.activity import VERBS
from tests.test_auth import assert_user_shape


@pytest.fixture
async def card_on_board(alice, board):
    board_id = board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    card = (
        await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Fix login redirect"})
    ).json()
    return {"board_id": board_id, "list": doing, "card": card}


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------


async def test_comment_shape(alice, card_on_board):
    response = await alice.post(
        "/api/cards/{}/comments".format(card_on_board["card"]["id"]), {"body": "Looks good"}
    )
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "card_id", "board_id", "author", "body", "created_at"}
    assert body["body"] == "Looks good"
    assert_user_shape(body["author"])


async def test_empty_comment_is_422(alice, card_on_board):
    response = await alice.post(
        "/api/cards/{}/comments".format(card_on_board["card"]["id"]), {"body": "   "}
    )
    assert response.status_code == 422
    assert response.json() == {"error": "Comment cannot be empty."}


async def test_comments_are_returned_oldest_first(alice, card_on_board):
    card_id = card_on_board["card"]["id"]
    for text in ("first", "second", "third"):
        await alice.post("/api/cards/{}/comments".format(card_id), {"body": text})

    body = (await alice.get("/api/cards/{}/comments".format(card_id))).json()
    assert [c["body"] for c in body["comments"]] == ["first", "second", "third"]


async def test_a_card_with_no_comments_returns_an_empty_list(alice, card_on_board):
    body = (await alice.get("/api/cards/{}/comments".format(card_on_board["card"]["id"]))).json()
    assert body == {"comments": []}


async def test_comment_count_appears_on_the_card(alice, card_on_board):
    card_id = card_on_board["card"]["id"]
    for text in ("one", "two"):
        await alice.post("/api/cards/{}/comments".format(card_id), {"body": text})

    snapshot = (await alice.get("/api/boards/{}".format(card_on_board["board_id"]))).json()
    assert snapshot["lists"][0]["cards"][0]["comment_count"] == 2


async def test_author_can_delete_their_comment(alice, card_on_board):
    card_id = card_on_board["card"]["id"]
    comment = (
        await alice.post("/api/cards/{}/comments".format(card_id), {"body": "Oops"})
    ).json()

    assert (await alice.delete("/api/comments/{}".format(comment["id"]))).status_code == 204
    assert (await alice.get("/api/cards/{}/comments".format(card_id))).json() == {"comments": []}


async def test_deleting_a_missing_comment_is_404(alice, card_on_board):
    response = await alice.delete("/api/comments/999999")
    assert response.status_code == 404
    assert response.json() == {"error": "Comment not found."}


async def test_comment_created_is_broadcast(
    alice, bob, shared_board, open_socket, ticket_for
):
    board_id = shared_board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    card = (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Card"})).json()

    socket = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket.drain()

    created = (
        await alice.post("/api/cards/{}/comments".format(card["id"]), {"body": "Live"})
    ).json()
    frame = await socket.receive_until("comment.created")
    assert frame["payload"] == created


# ---------------------------------------------------------------------------
# Activity
# ---------------------------------------------------------------------------


async def test_activity_shape(alice, board):
    body = (await alice.get("/api/boards/{}/activity".format(board["id"]))).json()
    assert set(body) == {"activity", "next_before_id"}
    entry = body["activity"][0]
    assert set(entry) == {"id", "board_id", "actor", "verb", "summary", "subject", "created_at"}
    assert entry["verb"] in VERBS
    assert_user_shape(entry["actor"])


async def test_every_mutation_writes_exactly_one_activity_entry(alice, board):
    board_id = board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    done = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Done"})).json()
    card = (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Fix login"})).json()
    await alice.patch(
        "/api/cards/{}/move".format(card["id"]),
        {"list_id": done["id"], "before_card_id": None, "after_card_id": None},
    )
    await alice.post("/api/cards/{}/comments".format(card["id"]), {"body": "Done!"})

    body = (await alice.get("/api/boards/{}/activity".format(board_id))).json()
    verbs = [entry["verb"] for entry in body["activity"]]
    # Newest first.
    assert verbs == [
        "comment.added",
        "card.moved",
        "card.created",
        "list.created",
        "list.created",
        "board.created",
    ]


async def test_cross_list_move_summary(alice, board):
    board_id = board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    done = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Done"})).json()
    card = (
        await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Fix login redirect"})
    ).json()

    await alice.patch(
        "/api/cards/{}/move".format(card["id"]),
        {"list_id": done["id"], "before_card_id": None, "after_card_id": None},
    )

    latest = (await alice.get("/api/boards/{}/activity".format(board_id))).json()["activity"][0]
    assert latest["summary"] == "Alice moved Fix login redirect from Doing to Done"
    assert latest["subject"] == {
        "card_id": card["id"],
        "card_title": "Fix login redirect",
        "from_list": "Doing",
        "to_list": "Done",
    }


async def test_within_list_move_summary_reads_as_a_reorder(alice, board):
    """Contract 5: same-list moves write card.moved with from_list == to_list."""
    board_id = board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    first = (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "One"})).json()
    second = (
        await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Fix login redirect"})
    ).json()

    await alice.patch(
        "/api/cards/{}/move".format(second["id"]),
        {"list_id": doing["id"], "before_card_id": None, "after_card_id": first["id"]},
    )

    latest = (await alice.get("/api/boards/{}/activity".format(board_id))).json()["activity"][0]
    assert latest["verb"] == "card.moved"
    assert latest["subject"]["from_list"] == latest["subject"]["to_list"] == "Doing"
    assert latest["summary"] == "Alice reordered Fix login redirect in Doing"


async def test_activity_is_paginated_by_before_id(alice, board):
    board_id = board["id"]
    for index in range(8):
        await alice.post("/api/boards/{}/lists".format(board_id), {"title": "L{}".format(index)})

    first_page = (
        await alice.get("/api/boards/{}/activity?limit=5".format(board_id))
    ).json()
    assert len(first_page["activity"]) == 5
    assert first_page["next_before_id"] == first_page["activity"][-1]["id"]

    second_page = (
        await alice.get(
            "/api/boards/{}/activity?limit=5&before_id={}".format(
                board_id, first_page["next_before_id"]
            )
        )
    ).json()
    assert len(second_page["activity"]) == 4  # 8 lists + board.created
    assert second_page["next_before_id"] is None

    first_ids = [e["id"] for e in first_page["activity"]]
    second_ids = [e["id"] for e in second_page["activity"]]
    assert set(first_ids).isdisjoint(second_ids)
    assert max(second_ids) < min(first_ids)


async def test_snapshot_carries_the_most_recent_50(alice, board):
    board_id = board["id"]
    for index in range(60):
        await alice.post("/api/boards/{}/lists".format(board_id), {"title": "L{}".format(index)})

    snapshot = (await alice.get("/api/boards/{}".format(board_id))).json()
    assert len(snapshot["activity"]) == 50
    ids = [entry["id"] for entry in snapshot["activity"]]
    assert ids == sorted(ids, reverse=True), "newest first"


async def test_activity_appended_is_broadcast(
    alice, bob, shared_board, open_socket, ticket_for
):
    board_id = shared_board["id"]
    socket = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket.drain()

    await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})
    frame = await socket.receive_until("activity.appended")
    assert frame["payload"]["verb"] == "list.created"
    assert frame["payload"]["actor"]["id"] == alice.id


async def test_a_list_move_writes_no_activity_entry(alice, board):
    """Contract 5's verb enumeration has no list.moved verb."""
    board_id = board["id"]
    first = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "A"})).json()
    second = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "B"})).json()

    before = (await alice.get("/api/boards/{}/activity".format(board_id))).json()["activity"]
    await alice.patch(
        "/api/lists/{}/move".format(second["id"]),
        {"before_list_id": None, "after_list_id": first["id"]},
    )
    after = (await alice.get("/api/boards/{}/activity".format(board_id))).json()["activity"]
    assert len(after) == len(before)


async def test_summaries_are_never_reconstructed_client_side(alice, board):
    """Every verb the API can emit renders a non-empty sentence on the server."""
    board_id = board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    card = (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Card"})).json()
    await alice.patch("/api/cards/{}".format(card["id"]), {"title": "Renamed"})
    await alice.patch("/api/cards/{}".format(card["id"]), {"description": "Details"})
    await alice.patch("/api/boards/{}".format(board_id), {"title": "Renamed board"})
    await alice.patch("/api/lists/{}".format(doing["id"]), {"title": "In progress"})
    await alice.delete("/api/cards/{}".format(card["id"]))
    await alice.delete("/api/lists/{}".format(doing["id"]))

    entries = (await alice.get("/api/boards/{}/activity".format(board_id))).json()["activity"]
    for entry in entries:
        assert entry["verb"] in VERBS
        assert entry["summary"].strip(), "verb {} rendered an empty summary".format(entry["verb"])
        assert entry["summary"].startswith("Alice ")
