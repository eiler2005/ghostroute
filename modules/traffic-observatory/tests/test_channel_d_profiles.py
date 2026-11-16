import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('channel_d_profiles', Path(__file__).resolve().parents[1] / 'lib/channel_d_profiles.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProfileMapTests(unittest.TestCase):
    def test_reorder_and_add_keep_original_slots(self):
        first = module.merge_profiles({}, [{'username': 'a', 'name': 'A'}, {'username': 'b', 'name': 'B'}])
        updated = module.merge_profiles(first, [{'username': 'b', 'name': 'B updated'}, {'username': 'a', 'name': 'A'}, {'username': 'c', 'name': 'C'}])
        self.assertEqual(updated['a']['client_key'], 'D-01')
        self.assertEqual(updated['b'], {'client_key': 'D-02', 'client_label': 'B updated'})
        self.assertEqual(updated['c']['client_key'], 'D-03')
        self.assertEqual(module.merge_profiles(updated, [{'username': 'c', 'name': 'C'}]), updated)

    def test_duplicate_slots_and_credentials_rejected(self):
        with self.assertRaises(ValueError):
            module.merge_profiles({}, [{'username': 'a', 'name': 'A'}, {'username': 'a', 'name': 'B'}])
        with self.assertRaises(ValueError):
            module.merge_profiles({'a': {'client_key': 'D-01'}, 'b': {'client_key': 'D-01'}}, [])


if __name__ == '__main__':
    unittest.main()
