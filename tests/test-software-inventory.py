#!/usr/bin/env python3
import copy
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader("software_inventory", str(ROOT / "modules/ghostroute-health-monitor/bin/software-inventory"))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / "configs/software-versions.json").read_text())

    def test_reviewed_repository_matches(self):
        self.assertEqual(module.validate(ROOT, self.data), [])

    def test_binding_drift_rejected(self):
        self.data["components"][0]["bindings"][0]["contains"] = "nonexistent-version"
        self.assertTrue(any("version drift" in e for e in module.validate(ROOT, self.data)))

    def test_escape_rejected(self):
        self.data["components"][0]["bindings"][0]["path"] = "../outside"
        self.assertTrue(any("outside repository" in e for e in module.validate(ROOT, self.data)))

    def test_duplicate_rejected(self):
        self.data["components"].append(copy.deepcopy(self.data["components"][0]))
        self.assertTrue(any("duplicate" in e for e in module.validate(ROOT, self.data)))

    def test_unproven_deployment_status_rejected(self):
        self.data["components"][0]["status"] = "latest_everywhere"
        self.assertTrue(any("invalid status" in e for e in module.validate(ROOT, self.data)))

    def test_npm_inventory_drift_rejected(self):
        next(c for c in self.data["components"] if c["id"].startswith("npm:"))["version"] = "0.0.0"
        self.assertTrue(any("inventory drift" in e for e in module.validate(ROOT, self.data)))


if __name__ == "__main__":
    unittest.main()
