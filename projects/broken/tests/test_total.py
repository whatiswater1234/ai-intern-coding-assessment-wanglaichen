import unittest


class TotalTests(unittest.TestCase):
    def test_invoice_total(self):
        # A deliberately failing project for the assessment demonstration.
        self.assertEqual(sum([12, 8]), 21)
