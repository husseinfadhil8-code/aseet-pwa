"""Run each migration's own contracts against that migration's schema.
Inherited helpers are reused; inherited tests for older schemas are NOT replayed
against incompatible later payment and RLS contracts. No hosted data is used.
"""
import unittest
from database import DatabaseTests
from settings_database import SettingsTests
from notifications_database import NotificationTests
from wanted_database import WantedTests
from intelligence_database import IntelligenceTests
from services_database import ServicesTests
suite=unittest.TestSuite()
for cls in [DatabaseTests,SettingsTests,NotificationTests,WantedTests,IntelligenceTests,ServicesTests]:
 suite.addTests(cls(name) for name in sorted(cls.__dict__) if name.startswith('test_') and callable(cls.__dict__[name]))
result=unittest.TextTestRunner(verbosity=1).run(suite)
raise SystemExit(not result.wasSuccessful())
