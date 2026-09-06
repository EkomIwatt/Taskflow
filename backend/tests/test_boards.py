"""Boards, membership and the snapshot — Contract 2."""

from tests.test_auth import assert_user_shape


async def test_new_account_has_no_boards(mallory):
    response = await mallory.get("/api/boards")
    assert response.status_code == 200
    assert response.json() == {"boards": []}


async def test_create_board_shape(alice):
    response = await alice.post("/api/boards", {"title": "Launch"})
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "title", "role", "member_count", "card_count", "updated_at"}
    assert body["title"] == "Launch"
    assert body["role"] == "owner"
    assert body["member_count"] == 1
    assert body["card_count"] == 0
    assert body["updated_at"].endswith("Z")


async def test_board_title_is_required(alice):
    response = await alice.post("/api/boards", {"title": "  "})
    assert response.status_code == 422
    assert response.json() == {"error": "Board title is required."}


async def test_board_list_counts_members_and_cards(alice, bob, shared_board):
    board_id = shared_board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    for title in ("A", "B"):
        await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": title})

    row = next(b for b in (await alice.get("/api/boards")).json()["boards"] if b["id"] == board_id)
    assert row["member_count"] == 2
    assert row["card_count"] == 2

    # Bob sees the same board, as a member.
    bob_row = next(
        b for b in (await bob.get("/api/boards")).json()["boards"] if b["id"] == board_id
    )
    assert bob_row["role"] == "member"


async def test_boards_are_ordered_by_most_recent_activity(alice):
    first = (await alice.post("/api/boards", {"title": "First"})).json()
    second = (await alice.post("/api/boards", {"title": "Second"})).json()

    # Touch the older board; it should come back to the top.
    await alice.post("/api/boards/{}/lists".format(first["id"]), {"title": "Doing"})

    ids = [b["id"] for b in (await alice.get("/api/boards")).json()["boards"]]
    assert ids[0] == first["id"]
    assert second["id"] in ids


async def test_snapshot_shape(alice, board):
    response = await alice.get("/api/boards/{}".format(board["id"]))
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"id", "title", "seq", "role", "members", "lists", "activity"}
    assert isinstance(body["seq"], int)
    assert body["role"] == "owner"

    member = body["members"][0]
    assert set(member) == {"user", "role", "added_at"}
    assert_user_shape(member["user"])
    assert member["role"] == "owner"


async def test_snapshot_nests_lists_and_cards_in_order(alice, board):
    board_id = board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Done"})
    cards = [
        (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": t})).json()
        for t in ("One", "Two")
    ]

    body = (await alice.get("/api/boards/{}".format(board_id))).json()
    assert [lst["title"] for lst in body["lists"]] == ["Doing", "Done"]

    first_list = body["lists"][0]
    # Contract 2 spells this nested shape out without board_id.
    assert set(first_list) == {"id", "title", "order_key", "cards"}
    assert [c["id"] for c in first_list["cards"]] == [c["id"] for c in cards]
    assert body["lists"][1]["cards"] == []


async def test_empty_board_snapshot_does_not_crash(alice, board):
    body = (await alice.get("/api/boards/{}".format(board["id"]))).json()
    assert body["lists"] == []
    assert len(body["members"]) == 1
    # board.created wrote one entry.
    assert [entry["verb"] for entry in body["activity"]] == ["board.created"]


async def test_snapshot_seq_advances_with_mutations(alice, board):
    before = (await alice.get("/api/boards/{}".format(board["id"]))).json()["seq"]
    await alice.post("/api/boards/{}/lists".format(board["id"]), {"title": "Doing"})
    after = (await alice.get("/api/boards/{}".format(board["id"]))).json()["seq"]
    # One state event plus one activity entry.
    assert after == before + 2


async def test_rename_board(alice, board):
    response = await alice.patch("/api/boards/{}".format(board["id"]), {"title": "Launch v2"})
    assert response.status_code == 200
    assert response.json() == {"id": board["id"], "title": "Launch v2"}


async def test_delete_board_cascades(alice, board):
    board_id = board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    card = (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": "One"})).json()

    assert (await alice.delete("/api/boards/{}".format(board_id))).status_code == 204
    assert (await alice.get("/api/boards/{}".format(board_id))).status_code == 404
    assert (await alice.get("/api/cards/{}/comments".format(card["id"]))).status_code == 404
    assert (await alice.get("/api/boards")).json()["boards"] == []


# ---------------------------------------------------------------------------
# Membership
# ---------------------------------------------------------------------------


async def test_add_member(alice, bob, board):
    response = await alice.post(
        "/api/boards/{}/members".format(board["id"]), {"email": bob.email}
    )
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"user", "role", "added_at"}
    assert body["user"]["id"] == bob.id
    assert body["role"] == "member"


async def test_add_member_with_unknown_email_is_404(alice, board):
    response = await alice.post(
        "/api/boards/{}/members".format(board["id"]), {"email": "nobody@example.com"}
    )
    assert response.status_code == 404
    assert response.json() == {"error": "No account with that email address."}


async def test_add_duplicate_member_is_409(alice, bob, shared_board):
    response = await alice.post(
        "/api/boards/{}/members".format(shared_board["id"]), {"email": bob.email}
    )
    assert response.status_code == 409
    assert response.json() == {"error": "That person is already a member of this board."}


async def test_owner_cannot_be_removed(alice, shared_board):
    response = await alice.delete(
        "/api/boards/{}/members/{}".format(shared_board["id"], alice.id)
    )
    assert response.status_code == 409
    assert response.json() == {"error": "The board owner cannot be removed."}


async def test_removed_member_loses_access(alice, bob, shared_board):
    board_id = shared_board["id"]
    assert (await bob.get("/api/boards/{}".format(board_id))).status_code == 200

    assert (
        await alice.delete("/api/boards/{}/members/{}".format(board_id, bob.id))
    ).status_code == 204

    assert (await bob.get("/api/boards/{}".format(board_id))).status_code == 404
    assert (await bob.get("/api/boards")).json()["boards"] == []


async def test_a_member_cannot_add_members(bob, shared_board):
    """Owner-only routes give a non-owner member the same 404 as a stranger."""
    response = await bob.post(
        "/api/boards/{}/members".format(shared_board["id"]), {"email": "x@example.com"}
    )
    assert response.status_code == 404
    assert response.json() == {"error": "Board not found."}


async def test_a_member_cannot_rename_or_delete_the_board(bob, shared_board):
    board_id = shared_board["id"]
    assert (await bob.patch("/api/boards/{}".format(board_id), {"title": "Mine"})).status_code == 404
    assert (await bob.delete("/api/boards/{}".format(board_id))).status_code == 404


async def test_a_member_can_edit_lists_and_cards(bob, shared_board):
    """Membership, not ownership, is what board content requires."""
    board_id = shared_board["id"]
    doing = (await bob.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    card = await bob.post("/api/lists/{}/cards".format(doing["id"]), {"title": "Bob's card"})
    assert card.status_code == 201
