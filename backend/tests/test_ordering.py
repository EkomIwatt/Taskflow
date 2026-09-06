"""Property tests for the fractional ordering algorithm — Contract 4.

The role prompt is explicit that examples are not enough here: the failure mode
of a naive midpoint implementation only shows up after dozens of inserts into
the *same gap*, so these tests drive thousands of randomised insert sequences
and assert the invariants after every single step.
"""

import random
import string

import pytest

from app.ordering import (
    DIGITS,
    MAX_KEY_LENGTH,
    OrderKeyError,
    key_between,
    sequential_keys,
    validate_order_key,
)


# --------------------------------------------------------------------------
# The alphabet itself
# --------------------------------------------------------------------------


def test_alphabet_is_ascii_ordered():
    """Contract 4 pins the alphabet order to ASCII: '0' < '9' < 'A' < 'Z' < 'a' < 'z'."""
    assert DIGITS == "".join(sorted(DIGITS))
    assert DIGITS == string.digits + string.ascii_uppercase + string.ascii_lowercase


def test_contract_example_keys():
    """The keys Contract 4 shows by name must be the keys we actually mint."""
    assert key_between(None, None) == "a0"
    assert key_between("a0", None) == "a1"
    assert key_between("a1", None) == "a2"
    # Contract 3's <Card> example: a card dropped between the first two.
    assert key_between("a0", "a1") == "a0V"


# --------------------------------------------------------------------------
# Basic strict-betweenness
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "a,b",
    [
        (None, None),
        ("a0", None),
        (None, "a0"),
        ("a0", "a1"),
        ("a0", "a0V"),
        ("a0V", "a1"),
        ("Zz", "a0"),
        ("az", "b00"),
    ],
)
def test_key_between_is_strictly_between(a, b):
    key = key_between(a, b)
    validate_order_key(key)
    if a is not None:
        assert a < key, "{!r} must sort after {!r}".format(key, a)
    if b is not None:
        assert key < b, "{!r} must sort before {!r}".format(key, b)


def test_key_between_rejects_inverted_neighbours():
    with pytest.raises(OrderKeyError):
        key_between("a1", "a0")


def test_key_between_rejects_equal_neighbours():
    """Equal keys are legal in the database (the (order_key, id) tie-break covers
    them) but there is no key strictly between them — callers must rebalance."""
    with pytest.raises(OrderKeyError):
        key_between("a0", "a0")


@pytest.mark.parametrize("bad", ["", "a", "a0 ", "!!", "a00", "0", "z"])
def test_validate_rejects_malformed_keys(bad):
    with pytest.raises(OrderKeyError):
        validate_order_key(bad)


# --------------------------------------------------------------------------
# I2: the server can always mint a key between any two neighbours
# --------------------------------------------------------------------------


def _assert_ordered_and_unique(keys):
    """The two invariants that matter, checked the way the client will see them.

    Sorting by plain string comparison must reproduce the intended order, and no
    two live siblings may share a key (Contract 4 I1).
    """
    assert sorted(keys) == keys, "keys do not sort into their intended order"
    assert len(set(keys)) == len(keys), "duplicate order keys"


def test_always_append_stays_short():
    """Appending is the common case and must not grow keys linearly."""
    keys = []
    previous = None
    for _ in range(5000):
        previous = key_between(previous, None)
        keys.append(previous)
        _assert_ordered_and_unique(keys)
    assert max(len(k) for k in keys) <= 4, "append should stay compact"
    assert max(len(k) for k in keys) <= MAX_KEY_LENGTH


def test_always_prepend_stays_short():
    keys = []
    first = None
    for _ in range(2000):
        first = key_between(None, first)
        keys.insert(0, first)
    _assert_ordered_and_unique(keys)
    assert max(len(k) for k in keys) <= MAX_KEY_LENGTH


def test_always_into_the_same_gap():
    """The pathological case: every insert lands between the same two cards.

    A naive midpoint implementation runs out of precision here around iteration
    40. This scheme grows the key by roughly one character every five inserts,
    so 250 inserts must still fit inside the 64-character budget.
    """
    low, high = key_between(None, None), key_between("a0", None)
    keys = [low, high]
    for _ in range(250):
        middle = key_between(low, high)
        assert low < middle < high
        keys.insert(1, middle)
        high = middle
        _assert_ordered_and_unique(keys)
    assert max(len(k) for k in keys) <= MAX_KEY_LENGTH


def test_always_into_the_same_gap_from_below():
    """The mirror image: repeatedly insert just *after* the same card."""
    low, high = key_between(None, None), key_between("a0", None)
    keys = [low, high]
    for _ in range(250):
        middle = key_between(low, high)
        assert low < middle < high
        keys.insert(-1, middle)
        low = middle
        _assert_ordered_and_unique(keys)
    assert max(len(k) for k in keys) <= MAX_KEY_LENGTH


@pytest.mark.parametrize("seed", range(25))
def test_random_insert_sequences_preserve_order(seed):
    """Thousands of random inserts at random positions, checked after every step."""
    rng = random.Random(seed)
    keys = []
    for _ in range(200):
        index = rng.randint(0, len(keys))
        before = keys[index - 1] if index > 0 else None
        after = keys[index] if index < len(keys) else None
        key = key_between(before, after)
        keys.insert(index, key)
        _assert_ordered_and_unique(keys)
    assert max(len(k) for k in keys) <= MAX_KEY_LENGTH


@pytest.mark.parametrize("seed", range(15))
def test_random_insert_and_delete(seed):
    """Deletions must not corrupt the space: a deleted key's room is simply reused."""
    rng = random.Random(1000 + seed)
    keys = []
    for _ in range(400):
        if keys and rng.random() < 0.3:
            keys.pop(rng.randrange(len(keys)))
            continue
        index = rng.randint(0, len(keys))
        before = keys[index - 1] if index > 0 else None
        after = keys[index] if index < len(keys) else None
        keys.insert(index, key_between(before, after))
        _assert_ordered_and_unique(keys)


@pytest.mark.parametrize("seed", range(15))
def test_random_moves_preserve_order(seed):
    """A move is a delete plus an insert — the operation the drag handler performs."""
    rng = random.Random(2000 + seed)
    keys = sequential_keys(20)
    for _ in range(500):
        source = rng.randrange(len(keys))
        moved = keys.pop(source)
        del moved
        target = rng.randint(0, len(keys))
        before = keys[target - 1] if target > 0 else None
        after = keys[target] if target < len(keys) else None
        keys.insert(target, key_between(before, after))
        _assert_ordered_and_unique(keys)
    assert max(len(k) for k in keys) <= MAX_KEY_LENGTH


# --------------------------------------------------------------------------
# sequential_keys — the rebalance primitive
# --------------------------------------------------------------------------


def test_sequential_keys_are_ordered_unique_and_short():
    keys = sequential_keys(500)
    assert len(keys) == 500
    _assert_ordered_and_unique(keys)
    assert max(len(k) for k in keys) <= 4


def test_sequential_keys_empty():
    assert sequential_keys(0) == []


def test_rebalance_restores_room_in_an_exhausted_gap():
    """The escape hatch that makes I2 true.

    Squeeze keys until they approach the length cap, then rebalance and confirm
    the gap is wide open again.
    """
    low, high = "a0", "a1"
    for _ in range(200):
        high = key_between(low, high)
    assert len(high) > 20, "expected the gap to be genuinely tight by now"

    rebalanced = sequential_keys(50)
    _assert_ordered_and_unique(rebalanced)
    assert max(len(k) for k in rebalanced) <= 4
    # And there is room between the first two again.
    assert rebalanced[0] < key_between(rebalanced[0], rebalanced[1]) < rebalanced[1]
