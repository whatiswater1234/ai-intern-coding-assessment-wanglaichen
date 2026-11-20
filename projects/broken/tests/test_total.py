import unittest

from billing import apply_coupon, line_subtotal


class TotalTests(unittest.TestCase):
    def test_empty_cart_is_zero(self):
        self.assertEqual(line_subtotal([]), 0)

    def test_coupon_never_goes_negative(self):
        self.assertEqual(apply_coupon(15, 30), 0)

    def test_invoice_total(self):
        # 故意保留的错误断言（12 + 8 = 20，此处断言 21），用于演示失败捕获与在线修复
        self.assertEqual(line_subtotal([12, 8]), 21)
