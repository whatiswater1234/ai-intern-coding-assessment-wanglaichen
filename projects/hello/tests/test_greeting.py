import unittest

from greeting import greet


class GreetingTests(unittest.TestCase):
    def test_greets_by_name(self):
        self.assertEqual(greet("Mac"), "Hello, Mac!")
