import unittest
from display.kiosk_policy import RecoveryPolicy, RestartPolicy, ScreenPolicy


class RecoveryTests(unittest.TestCase):
    def test_startup_without_ha_has_immediate_local_fallback(self):
        policy = RecoveryPolicy()
        self.assertEqual(policy.update(0, "offline", True), "local")
        self.assertEqual(policy.update(5, "ready", True), "local")
        self.assertEqual(policy.update(10, "ready", True), "ha")

    def test_healthy_views_are_retained_and_transient_disconnect_is_tolerated(self):
        policy = RecoveryPolicy(front="ha")
        self.assertEqual(policy.update(0, "ready", True), "ha")
        self.assertEqual(policy.update(5, "offline", True), "ha")
        self.assertEqual(policy.update(10, "ready", True), "ha")
        self.assertEqual(policy.update(60, "offline", True), "ha")
        self.assertEqual(policy.update(80, "offline", True), "local")

    def test_http_loading_and_login_are_not_authenticated_readiness(self):
        for state in ("loading", "login", "offline"):
            policy = RecoveryPolicy()
            for now in range(0, 300, 5):
                self.assertEqual(policy.update(now, state, False), "offline")

    def test_return_requires_consecutive_readiness(self):
        policy = RecoveryPolicy()
        for state in ("ready", "offline", "ready", "login", "ready"):
            self.assertEqual(policy.update(0, state, True), "local")
        self.assertEqual(policy.update(5, "ready", True), "ha")

    def test_restarts_are_capped_and_reset_after_a_stable_run(self):
        policy = RestartPolicy()
        self.assertEqual([policy.failed(1) - 1 for _ in range(6)], [5, 15, 30, 60, 60, 60])
        policy.started_at = 20
        self.assertEqual(policy.failed(320), 325)


class ScreenTests(unittest.TestCase):
    def test_disabling_night_blanking_lights_screen_and_reenable_grants_idle_interval(self):
        policy = ScreenPolicy()
        self.assertEqual(policy.update(0, 23, False), (False, True))
        self.assertEqual(policy.update(1, 23, False, False), (True, False))
        self.assertEqual(policy.update(1000, 2, False, False), (True, False))
        self.assertEqual(policy.update(1001, 2, False, True), (True, False))
        self.assertEqual(policy.update(1120, 2, False, True), (True, False))
        self.assertEqual(policy.update(1121, 2, False, True), (False, True))

    def test_disabling_during_wake_does_not_release_a_held_wake_contact(self):
        policy = ScreenPolicy()
        policy.update(0, 23, False)
        self.assertEqual(policy.update(1, 23, True), (True, True))
        self.assertEqual(policy.update(2, 23, True, False), (True, True))
        self.assertEqual(policy.update(3, 23, False, False), (True, False))

    def test_day_stays_lit_and_night_starts_dark_with_grab(self):
        policy = ScreenPolicy()
        self.assertEqual(policy.update(0, 7, False), (True, False))
        self.assertEqual(policy.update(1, 22, False), (True, False))
        self.assertEqual(policy.update(2, 23, False), (False, True))

    def test_wake_contact_is_consumed_until_complete_release(self):
        policy = ScreenPolicy()
        policy.update(0, 23, False)
        self.assertEqual(policy.update(1, 23, True), (True, True))
        self.assertEqual(policy.update(2, 23, True), (True, True))
        self.assertEqual(policy.update(3, 23, False), (True, False))
        self.assertEqual(policy.update(120, 23, False), (True, False))
        self.assertEqual(policy.update(122, 23, False), (True, False))
        self.assertEqual(policy.update(123, 23, False), (False, True))

    def test_later_touch_restarts_idle_timer_without_consuming_it(self):
        policy = ScreenPolicy()
        policy.update(0, 23, False)
        policy.update(1, 23, True)
        policy.update(2, 23, False)
        self.assertEqual(policy.update(100, 23, True), (True, False))
        self.assertEqual(policy.update(101, 23, False), (True, False))
        self.assertEqual(policy.update(122, 23, False), (True, False))
        self.assertEqual(policy.update(220, 23, False), (True, False))
        self.assertEqual(policy.update(221, 23, False), (False, True))
        self.assertEqual(policy.update(222, 23, True), (True, True))

    def test_held_contact_stays_lit_then_gets_full_idle_interval_after_release(self):
        policy = ScreenPolicy()
        policy.update(0, 23, False)
        policy.update(1, 23, True)
        policy.update(2, 23, False)
        self.assertEqual(policy.update(100, 23, True), (True, False))
        self.assertEqual(policy.update(300, 23, True), (True, False))
        self.assertEqual(policy.update(301, 23, False), (True, False))
        self.assertEqual(policy.update(420, 23, False), (True, False))
        self.assertEqual(policy.update(421, 23, False), (False, True))

    def test_normal_held_contact_is_not_interrupted_at_night_boundary(self):
        policy = ScreenPolicy()
        self.assertEqual(policy.update(0, 23, True), (True, False))
        self.assertEqual(policy.update(1, 23, False), (True, False))
        self.assertEqual(policy.update(121, 23, False), (False, True))
        self.assertEqual(policy.update(122, 0, True), (True, True))
        self.assertEqual(policy.update(123, 7, True), (True, True))
        self.assertEqual(policy.update(124, 7, False), (True, False))


if __name__ == "__main__":
    unittest.main()
