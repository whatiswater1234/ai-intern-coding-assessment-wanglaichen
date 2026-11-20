import unittest

from greeting import format_release_banner, greet


class GreetingTests(unittest.TestCase):
    def test_greets_by_name(self):
        self.assertEqual(greet("Mac"), "Hello, Mac!")

    def test_trims_surrounding_whitespace(self):
        self.assertEqual(greet("  Apple Silicon  "), "Hello, Apple Silicon!")

    def test_empty_name_uses_default(self):
        self.assertEqual(greet("   "), "Hello, World!")

    def test_formats_release_banner(self):
        self.assertEqual(format_release_banner("task-runner", "1.0"), "[task-runner v1.0] ready")
