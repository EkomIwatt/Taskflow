"""Lists, cards and the move endpoint — Contracts 3 and 4.

The move tests are the graded ones. They check three things the contract makes
promises about and that nothing else in the suite covers: that the server never
accepts an order key from a client, that a stale neighbour produces a 409 rather
than a guessed position, and that one card moved updates exactly one row.
"""

import pytest
from sqlalchemy import event, select

from app.models import Card
from app.ordering import validate_order_key


def sorted_ids(cards):
    """The binding sort of Contract 4: (order_key, id) ascending."""
    return [c["id"] for c in sorted(cards, key=lambda c: (c["order_key"], c["id"]))]


@pytest.fixture
def sql_statements(engine):
    """Capture every statement the engine executes, for the one-row check."""
    captured = []

    def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        captured.append((statement, parameters))

    event.listen(engine.sync_engine, "before_cursor_execute", before_cursor_execute)
    yield captured
    event.remove(engine.sync_engine, "before_cursor_execute", before_cursor_execute)


@pytest.fixture
async def workspace(alice, board):
    """A board with two lists and three cards in the first one."""
    board_id = board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    done = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Done"})).json()
    cards = []
    for title in ("One", "Two", "Three"):
        response = await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": title})
        assert response.status_code == 201
        cards.append(response.json())
    return {"board_id": board_id, "doing": doing, "done": done, "cards": cards}


# ---------------------------------------------------------------------------
# Lists
# ---------------------------------------------------------------------------


async def test_create_list_shape(alice, board):
    response = await alice.post(
        "/api/boards/{}/lists".format(board["id"]), {"title": "Doing", "after_list_id": None}
    )
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "board_id", "title", "order_key", "cards"}
    assert body["cards"] == []
    validate_order_key(body["order_key"])


async def test_list_title_is_required(alice, board):
    response = await alice.post("/api/boards/{}/lists".format(board["id"]), {"title": "   "})
    assert response.status_code == 422
    assert response.json() == {"error": "List title is required."}


async def test_lists_append_in_order(alice, board):
    keys = []
    for title in ("A", "B", "C"):
        body = (await alice.post("/api/boards/{}/lists".format(board["id"]), {"title": title})).json()
        keys.append(body["order_key"])
    assert keys == sorted(keys)


async def test_create_list_after_a_named_list(alice, board):
    first = (await alice.post("/api/boards/{}/lists".format(board["id"]), {"title": "A"})).json()
    last = (await alice.post("/api/boards/{}/lists".format(board["id"]), {"title": "C"})).json()
    middle = (
        await alice.post(
            "/api/boards/{}/lists".format(board["id"]),
            {"title": "B", "after_list_id": first["id"]},
        )
    ).json()
    assert first["order_key"] < middle["order_key"] < last["order_key"]


async def test_rename_list(alice, board):
    created = (await alice.post("/api/boards/{}/lists".format(board["id"]), {"title": "A"})).json()
    response = await alice.patch("/api/lists/{}".format(created["id"]), {"title": "Renamed"})
    assert response.status_code == 200
    assert response.json() == {"id": created["id"], "title": "Renamed"}


async def test_move_list_between_neighbours(alice, workspace):
    board_id = workspace["board_id"]
    doing, done = workspace["doing"], workspace["done"]
    third = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Third"})).json()

    # Put `third` between doing and done.
    response = await alice.patch(
        "/api/lists/{}/move".format(third["id"]),
        {"before_list_id": doing["id"], "after_list_id": done["id"]},
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"id", "order_key"}
    assert doing["order_key"] < body["order_key"] < done["order_key"]

    snapshot = (await alice.get("/api/boards/{}".format(board_id))).json()
    assert [lst["id"] for lst in snapshot["lists"]] == [doing["id"], third["id"], done["id"]]


async def test_move_list_next_to_a_deleted_neighbour_is_409(alice, workspace):
    doing, done = workspace["doing"], workspace["done"]
    await alice.delete("/api/lists/{}".format(done["id"]))

    response = await alice.patch(
        "/api/lists/{}/move".format(doing["id"]),
        {"before_list_id": None, "after_list_id": done["id"]},
    )
    assert response.status_code == 409
    assert response.json() == {
        "error": "The board changed while you were dragging. Refreshing."
    }


async def test_delete_list_cascades_its_cards(alice, workspace, db):
    doing = workspace["doing"]
    response = await alice.delete("/api/lists/{}".format(doing["id"]))
    assert response.status_code == 204

    remaining = (await db.execute(select(Card).where(Card.list_id == doing["id"]))).scalars().all()
    assert remaining == []

    snapshot = (await alice.get("/api/boards/{}".format(workspace["board_id"]))).json()
    assert [lst["id"] for lst in snapshot["lists"]] == [workspace["done"]["id"]]


# ---------------------------------------------------------------------------
# Cards
# ---------------------------------------------------------------------------


async def test_create_card_shape(alice, workspace):
    card = workspace["cards"][0]
    assert set(card) == {
        "id",
        "list_id",
        "board_id",
        "title",
        "description",
        "order_key",
        "comment_count",
        "created_by",
        "created_at",
        "updated_at",
    }
    assert card["description"] == ""
    assert card["comment_count"] == 0
    assert card["created_by"]["id"] == alice.id
    validate_order_key(card["order_key"])


async def test_card_title_is_required(alice, workspace):
    response = await alice.post("/api/lists/{}/cards".format(workspace["doing"]["id"]), {})
    assert response.status_code == 422
    assert response.json() == {"error": "Card title is required."}


async def test_cards_append_in_order(alice, workspace):
    keys = [card["order_key"] for card in workspace["cards"]]
    assert keys == sorted(keys)


async def test_create_card_after_a_named_card(alice, workspace):
    first, second, _third = workspace["cards"]
    inserted = (
        await alice.post(
            "/api/lists/{}/cards".format(workspace["doing"]["id"]),
            {"title": "Inserted", "after_card_id": first["id"]},
        )
    ).json()
    assert first["order_key"] < inserted["order_key"] < second["order_key"]


async def test_patch_card_title_and_description(alice, workspace):
    card = workspace["cards"][0]
    response = await alice.patch(
        "/api/cards/{}".format(card["id"]), {"title": "Renamed", "description": "Details"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Renamed"
    assert body["description"] == "Details"


async def test_patch_card_is_partial(alice, workspace):
    card = workspace["cards"][0]
    await alice.patch("/api/cards/{}".format(card["id"]), {"description": "Only this"})
    body = (
        await alice.patch("/api/cards/{}".format(card["id"]), {"title": "Only the title"})
    ).json()
    assert body["title"] == "Only the title"
    assert body["description"] == "Only this", "an absent key must mean unchanged"


async def test_patch_card_with_no_fields_is_422(alice, workspace):
    response = await alice.patch("/api/cards/{}".format(workspace["cards"][0]["id"]), {})
    assert response.status_code == 422


async def test_delete_card(alice, workspace):
    card = workspace["cards"][0]
    assert (await alice.delete("/api/cards/{}".format(card["id"]))).status_code == 204
    assert (await alice.patch("/api/cards/{}".format(card["id"]), {"title": "x"})).status_code == 404


# ---------------------------------------------------------------------------
# The move
# ---------------------------------------------------------------------------


async def test_move_card_to_another_list(alice, workspace):
    card = workspace["cards"][0]
    response = await alice.patch(
        "/api/cards/{}/move".format(card["id"]),
        {"list_id": workspace["done"]["id"], "before_card_id": None, "after_card_id": None},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["list_id"] == workspace["done"]["id"]
    validate_order_key(body["order_key"])


async def test_move_card_into_a_gap(alice, workspace):
    """The heart of it: drop card three between one and two."""
    one, two, three = workspace["cards"]
    response = await alice.patch(
        "/api/cards/{}/move".format(three["id"]),
        {
            "list_id": workspace["doing"]["id"],
            "before_card_id": one["id"],
            "after_card_id": two["id"],
        },
    )
    assert response.status_code == 200
    moved = response.json()
    assert one["order_key"] < moved["order_key"] < two["order_key"]

    snapshot = (await alice.get("/api/boards/{}".format(workspace["board_id"]))).json()
    doing = next(lst for lst in snapshot["lists"] if lst["id"] == workspace["doing"]["id"])
    assert [c["id"] for c in doing["cards"]] == [one["id"], three["id"], two["id"]]


async def test_move_to_the_top_and_the_bottom(alice, workspace):
    one, two, three = workspace["cards"]
    doing_id = workspace["doing"]["id"]

    to_top = await alice.patch(
        "/api/cards/{}/move".format(three["id"]),
        {"list_id": doing_id, "before_card_id": None, "after_card_id": one["id"]},
    )
    assert to_top.status_code == 200
    assert to_top.json()["order_key"] < one["order_key"]

    to_bottom = await alice.patch(
        "/api/cards/{}/move".format(one["id"]),
        {"list_id": doing_id, "before_card_id": two["id"], "after_card_id": None},
    )
    assert to_bottom.status_code == 200
    assert to_bottom.json()["order_key"] > two["order_key"]


async def test_move_with_a_deleted_neighbour_is_409_and_changes_nothing(alice, workspace):
    one, two, three = workspace["cards"]
    await alice.delete("/api/cards/{}".format(two["id"]))

    response = await alice.patch(
        "/api/cards/{}/move".format(three["id"]),
        {
            "list_id": workspace["doing"]["id"],
            "before_card_id": one["id"],
            "after_card_id": two["id"],
        },
    )
    assert response.status_code == 409
    assert response.json() == {
        "error": "The board changed while you were dragging. Refreshing."
    }

    snapshot = (await alice.get("/api/boards/{}".format(workspace["board_id"]))).json()
    doing = next(lst for lst in snapshot["lists"] if lst["id"] == workspace["doing"]["id"])
    unchanged = next(c for c in doing["cards"] if c["id"] == three["id"])
    assert unchanged["order_key"] == three["order_key"]


async def test_move_with_a_relocated_neighbour_is_409(alice, workspace):
    """The neighbour still exists but no longer sits in the destination list."""
    one, two, three = workspace["cards"]
    await alice.patch(
        "/api/cards/{}/move".format(two["id"]),
        {"list_id": workspace["done"]["id"], "before_card_id": None, "after_card_id": None},
    )

    response = await alice.patch(
        "/api/cards/{}/move".format(three["id"]),
        {
            "list_id": workspace["doing"]["id"],
            "before_card_id": one["id"],
            "after_card_id": two["id"],
        },
    )
    assert response.status_code == 409


async def test_move_to_another_board_is_422(alice, workspace):
    other_board = (await alice.post("/api/boards", {"title": "Other"})).json()
    other_list = (
        await alice.post("/api/boards/{}/lists".format(other_board["id"]), {"title": "Elsewhere"})
    ).json()

    response = await alice.patch(
        "/api/cards/{}/move".format(workspace["cards"][0]["id"]),
        {"list_id": other_list["id"], "before_card_id": None, "after_card_id": None},
    )
    assert response.status_code == 422
    assert response.json() == {"error": "Cards cannot be moved to another board."}


async def test_move_a_missing_card_is_404(alice, workspace):
    response = await alice.patch(
        "/api/cards/999999/move",
        {"list_id": workspace["doing"]["id"], "before_card_id": None, "after_card_id": None},
    )
    assert response.status_code == 404
    assert response.json() == {"error": "Card not found."}


async def test_the_server_never_accepts_an_order_key_from_a_client(alice, workspace):
    """Contract 4: 'Do not accept an order_key from a client, ever.'"""
    card = workspace["cards"][0]
    response = await alice.patch(
        "/api/cards/{}/move".format(card["id"]),
        {
            "list_id": workspace["doing"]["id"],
            "before_card_id": None,
            "after_card_id": None,
            "order_key": "zzzzz",
        },
    )
    assert response.status_code == 200
    assert response.json()["order_key"] != "zzzzz"


async def test_one_move_updates_exactly_one_row(alice, workspace, sql_statements):
    """The project's whole premise, checked against the real database.

    A normal move must not renumber siblings. If this test ever fails, the
    implementation has become integer positions with extra steps.
    """
    one, two, three = workspace["cards"]
    sql_statements.clear()

    response = await alice.patch(
        "/api/cards/{}/move".format(three["id"]),
        {
            "list_id": workspace["doing"]["id"],
            "before_card_id": one["id"],
            "after_card_id": two["id"],
        },
    )
    assert response.status_code == 200

    card_updates = [
        statement
        for statement, _params in sql_statements
        if statement.strip().upper().startswith("UPDATE CARDS")
    ]
    assert len(card_updates) == 1, "expected one UPDATE on cards, got:\n{}".format(
        "\n".join(card_updates)
    )
    # And that one statement targets a single row by primary key.
    assert "WHERE cards.id = ?" in card_updates[0]


async def test_a_long_list_still_moves_one_row(alice, workspace, sql_statements):
    """Same check with a 20-card list, which is the merge-time manual check."""
    doing_id = workspace["doing"]["id"]
    cards = list(workspace["cards"])
    for index in range(17):
        cards.append(
            (
                await alice.post(
                    "/api/lists/{}/cards".format(doing_id), {"title": "Card {}".format(index)}
                )
            ).json()
        )
    assert len(cards) == 20
    sql_statements.clear()

    response = await alice.patch(
        "/api/cards/{}/move".format(cards[-1]["id"]),
        {
            "list_id": doing_id,
            "before_card_id": cards[9]["id"],
            "after_card_id": cards[10]["id"],
        },
    )
    assert response.status_code == 200
    card_updates = [
        statement
        for statement, _ in sql_statements
        if statement.strip().upper().startswith("UPDATE CARDS")
    ]
    assert len(card_updates) == 1


async def test_the_tie_break_keeps_duplicate_keys_deterministic(alice, workspace, db):
    """Two cards sharing an order_key is legal; (order_key, id) resolves it.

    Contract 4 requires both sides to implement the tie-break and to test it
    with a fixture where two cards share a key, so here is that fixture.
    """
    one, two, _three = workspace["cards"]
    shared = one["order_key"]
    card = await db.get(Card, two["id"])
    card.order_key = shared
    db.add(card)
    await db.commit()

    snapshot = (await alice.get("/api/boards/{}".format(workspace["board_id"]))).json()
    doing = next(lst for lst in snapshot["lists"] if lst["id"] == workspace["doing"]["id"])
    ids = [c["id"] for c in doing["cards"]]
    # Both present, neither lost, ordered by id within the shared key.
    assert ids[:2] == sorted([one["id"], two["id"]])
    assert sorted_ids(doing["cards"]) == ids


async def test_moving_between_two_cards_that_share_a_key_rebalances(alice, workspace, db):
    """There is no key strictly between two equal keys, so the escape hatch fires."""
    one, two, three = workspace["cards"]
    card = await db.get(Card, two["id"])
    card.order_key = one["order_key"]
    db.add(card)
    await db.commit()

    response = await alice.patch(
        "/api/cards/{}/move".format(three["id"]),
        {
            "list_id": workspace["doing"]["id"],
            "before_card_id": one["id"],
            "after_card_id": two["id"],
        },
    )
    assert response.status_code == 200

    snapshot = (await alice.get("/api/boards/{}".format(workspace["board_id"]))).json()
    doing = next(lst for lst in snapshot["lists"] if lst["id"] == workspace["doing"]["id"])
    keys = [c["order_key"] for c in doing["cards"]]
    assert len(set(keys)) == len(keys), "rebalance must leave every key unique"
    assert keys == sorted(keys)
    assert [c["id"] for c in doing["cards"]] == [one["id"], three["id"], two["id"]]


async def test_rebalance_is_broadcast(alice, bob, shared_board, open_socket, ticket_for, db):
    """Instance 2 has a handler for list.rebalanced; prove it actually fires."""
    board_id = shared_board["id"]
    doing = (await alice.post("/api/boards/{}/lists".format(board_id), {"title": "Doing"})).json()
    cards = [
        (await alice.post("/api/lists/{}/cards".format(doing["id"]), {"title": t})).json()
        for t in ("One", "Two", "Three")
    ]

    duplicate = await db.get(Card, cards[1]["id"])
    duplicate.order_key = cards[0]["order_key"]
    db.add(duplicate)
    await db.commit()

    socket = await open_socket(board_id, await ticket_for(bob, board_id))
    await socket.drain()

    await alice.patch(
        "/api/cards/{}/move".format(cards[2]["id"]),
        {
            "list_id": doing["id"],
            "before_card_id": cards[0]["id"],
            "after_card_id": cards[1]["id"],
        },
    )

    frame = await socket.receive_until("list.rebalanced")
    assert frame["actor_id"] is None, "a rebalance is server-originated"
    assert frame["seq"] is not None
    assert frame["payload"]["list_id"] == doing["id"]
    assert set(frame["payload"]) == {"list_id", "cards"}
    for entry in frame["payload"]["cards"]:
        assert set(entry) == {"id", "order_key"}
