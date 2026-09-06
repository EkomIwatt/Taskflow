"""Fractional (lexicographic) order keys — Contract 4.

This module is the sole implementation of the ordering algorithm in the whole
project. Contract 4 makes the key an *opaque sortable string*: the client stores
it, sorts by it, and never generates, parses or reasons about it. Keeping the
algorithm in exactly one language on exactly one side of the process boundary is
the decision that lets the two instances build in parallel.

Keys are base-62 strings over ``0-9A-Za-z``, whose ASCII order is also the
alphabet's order, so plain byte-wise string comparison sorts them correctly in
both Python and JavaScript.

A key is ``<integer part><fraction part>``:

* The **integer part**'s first character encodes its own total length
  (``a`` -> 2 chars, ``b`` -> 3 ... ``z`` -> 27 for non-negative magnitudes;
  ``Z`` -> 2, ``Y`` -> 3 ... ``A`` -> 27 for negative ones). Appending to the end
  of a list therefore just increments an integer -- ``a0``, ``a1`` ... ``az``,
  ``b00`` -- so key length grows logarithmically, not linearly.
* The **fraction part** is a base-62 fraction with an implied leading ``0.``. It
  only appears when a key must be minted strictly between two neighbours that
  are already adjacent integers, e.g. between ``a0`` and ``a1`` -> ``a0V``.

Invariants (Contract 4 I1-I4) are enforced here and property-tested in
``tests/test_ordering.py``.
"""

from typing import List, Optional

#: Base-62 alphabet. Its order is ASCII order: '0' < '9' < 'A' < 'Z' < 'a' < 'z'.
DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

BASE = len(DIGITS)
ZERO = DIGITS[0]

#: Contract 4 caps a key at 64 characters. Callers use this to decide when a
#: list has to be rebalanced instead of squeezing in yet another key.
MAX_KEY_LENGTH = 64

#: The smallest representable integer part. Reserved as a floor sentinel so
#: ``key_between(None, x)`` always has somewhere to go.
SMALLEST_INTEGER = "A" + ZERO * 26

_DIGIT_INDEX = {c: i for i, c in enumerate(DIGITS)}


class OrderKeyError(ValueError):
    """Raised when an order key is malformed or a key cannot be minted.

    This is an internal invariant failure, never something the client sees: the
    routes rebalance and retry rather than surface it (Contract 4 I2).
    """


def _integer_length(head: str) -> int:
    """Total length of the integer part whose first character is ``head``."""
    if "a" <= head <= "z":
        return ord(head) - ord("a") + 2
    if "A" <= head <= "Z":
        return ord("Z") - ord(head) + 2
    raise OrderKeyError("Invalid order key head: {!r}".format(head))


def _integer_part(key: str) -> str:
    if not key:
        raise OrderKeyError("Order key must not be empty.")
    length = _integer_length(key[0])
    if length > len(key):
        raise OrderKeyError("Order key {!r} is shorter than its integer part.".format(key))
    return key[:length]


def validate_order_key(key: str) -> None:
    """Raise :class:`OrderKeyError` unless ``key`` is a well-formed order key.

    Well-formed means: a valid integer part, no trailing zero digit in the
    fraction (``a0`` and ``a00`` would otherwise denote the same position), and
    not the reserved floor sentinel.
    """
    if not isinstance(key, str) or not key:
        raise OrderKeyError("Order key must be a non-empty string.")
    for char in key:
        if char not in _DIGIT_INDEX:
            raise OrderKeyError("Order key {!r} contains a non-base-62 character.".format(key))
    if key == SMALLEST_INTEGER:
        raise OrderKeyError("Order key {!r} is the reserved floor sentinel.".format(key))
    integer = _integer_part(key)
    fraction = key[len(integer):]
    if fraction.endswith(ZERO):
        raise OrderKeyError("Order key {!r} has a trailing zero in its fraction.".format(key))


def _increment_integer(integer: str) -> Optional[str]:
    """Next integer part after ``integer``, or ``None`` on overflow past ``z``."""
    head, digits = integer[0], list(integer[1:])
    carry = True
    for i in range(len(digits) - 1, -1, -1):
        value = _DIGIT_INDEX[digits[i]] + 1
        if value == BASE:
            digits[i] = ZERO
        else:
            digits[i] = DIGITS[value]
            carry = False
            break
    if not carry:
        return head + "".join(digits)
    if head == "Z":
        return "a" + ZERO
    if head == "z":
        return None
    next_head = chr(ord(head) + 1)
    if next_head > "a":
        digits.append(ZERO)
    else:
        digits.pop()
    return next_head + "".join(digits)


def _decrement_integer(integer: str) -> Optional[str]:
    """Previous integer part before ``integer``, or ``None`` on underflow past ``A``."""
    head, digits = integer[0], list(integer[1:])
    borrow = True
    for i in range(len(digits) - 1, -1, -1):
        value = _DIGIT_INDEX[digits[i]] - 1
        if value < 0:
            digits[i] = DIGITS[BASE - 1]
        else:
            digits[i] = DIGITS[value]
            borrow = False
            break
    if not borrow:
        return head + "".join(digits)
    if head == "a":
        return "Z" + DIGITS[BASE - 1]
    if head == "A":
        return None
    prev_head = chr(ord(head) - 1)
    if prev_head < "Z":
        digits.append(DIGITS[BASE - 1])
    else:
        digits.pop()
    return prev_head + "".join(digits)


def _midpoint(a: str, b: Optional[str]) -> str:
    """A base-62 fraction strictly between fractions ``a`` and ``b``.

    ``a`` may be ``""`` (meaning 0) and ``b`` may be ``None`` (meaning 1). Both
    are bare fraction digit-strings with no trailing zero. The result never has
    a trailing zero either, so it is itself a legal fraction.
    """
    if b is not None and a >= b:
        raise OrderKeyError("Cannot take a midpoint of {!r} and {!r}.".format(a, b))
    if a.endswith(ZERO) or (b is not None and b.endswith(ZERO)):
        raise OrderKeyError("Midpoint operands must not have a trailing zero.")

    if b is not None:
        # Strip the longest common prefix, padding `a` with implicit zeros.
        n = 0
        while n < len(b) and (a[n] if n < len(a) else ZERO) == b[n]:
            n += 1
        if n > 0:
            return b[:n] + _midpoint(a[n:], b[n:])

    digit_a = _DIGIT_INDEX[a[0]] if a else 0
    digit_b = _DIGIT_INDEX[b[0]] if b is not None else BASE

    if digit_b - digit_a > 1:
        # There is at least one whole digit of room between them.
        return DIGITS[(digit_a + digit_b) // 2]

    # The leading digits are consecutive, so the answer must extend one of them.
    if b is not None and len(b) > 1:
        # b's own leading digit is already strictly between a and b.
        return b[:1]
    # b is None, or a single digit with nothing to spare: descend into a's tail.
    return DIGITS[digit_a] + _midpoint(a[1:], None)


def key_between(a: Optional[str], b: Optional[str]) -> str:
    """Mint an order key strictly between ``a`` and ``b``.

    ``None`` means "no neighbour on that side": ``key_between(None, None)``
    returns the first key of an empty list, ``key_between(a, None)`` appends
    after ``a``, and ``key_between(None, b)`` prepends before ``b``.

    The result always satisfies ``a < result < b`` under plain string
    comparison, which is the only property either side of the contract relies on.
    """
    if a is not None:
        validate_order_key(a)
    if b is not None:
        validate_order_key(b)
    if a is not None and b is not None and a >= b:
        raise OrderKeyError("Order key {!r} is not strictly before {!r}.".format(a, b))

    if a is None:
        if b is None:
            return "a" + ZERO
        integer_b = _integer_part(b)
        fraction_b = b[len(integer_b):]
        if integer_b == SMALLEST_INTEGER:
            # Already at the floor: the only room left is inside the fraction.
            return integer_b + _midpoint("", fraction_b)
        if fraction_b:
            # b carries a fraction, so its bare integer part sits below it.
            return integer_b
        previous = _decrement_integer(integer_b)
        if previous is None:
            raise OrderKeyError("Cannot mint a key below {!r}.".format(b))
        return previous

    integer_a = _integer_part(a)
    fraction_a = a[len(integer_a):]

    if b is None:
        following = _increment_integer(integer_a)
        if following is None:
            # Integer space exhausted at 'z...': grow the fraction instead.
            return integer_a + _midpoint(fraction_a, None)
        return following

    integer_b = _integer_part(b)
    fraction_b = b[len(integer_b):]

    if integer_a == integer_b:
        return integer_a + _midpoint(fraction_a, fraction_b)

    following = _increment_integer(integer_a)
    if following is None:
        raise OrderKeyError("Cannot mint a key above {!r}.".format(a))
    if following < b:
        return following
    return integer_a + _midpoint(fraction_a, None)


def sequential_keys(count: int) -> List[str]:
    """``count`` evenly spaced keys in ascending order, starting from scratch.

    Used by the rebalance path (Contract 4) to renormalise a list, and by any
    caller that needs to lay out a whole run of siblings at once. The keys are
    the shortest the scheme produces: ``a0``, ``a1``, ``a2`` ...
    """
    if count < 0:
        raise ValueError("count must not be negative")
    keys: List[str] = []
    previous: Optional[str] = None
    for _ in range(count):
        previous = key_between(previous, None)
        keys.append(previous)
    return keys
