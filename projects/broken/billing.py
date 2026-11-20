def line_subtotal(prices):
    return sum(prices)


def apply_coupon(subtotal, discount):
    return max(0, subtotal - discount)
