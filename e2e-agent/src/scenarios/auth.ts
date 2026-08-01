/**
 * Auth test scenarios.
 * Each goal is natural language that the AI agent interprets and executes.
 */
import type { TestScenario } from '../types.js';

export const authScenarios: TestScenario[] = [
  {
    id: 'AUTH-01',
    name: 'Login page renders correctly',
    suite: 'auth',
    tags: ['smoke', 'auth'],
    authState: 'logged-out',
    goal: `Navigate to /login. Verify the login form is present by checking that:
- An email input field exists (look for placeholder "email" or type="email")
- A password input field exists
- A "Sign In" or "Login" button is visible
Take a screenshot to confirm, then finish with pass if all elements are found.`,
  },

  {
    id: 'AUTH-02',
    name: 'Valid login redirects to dashboard',
    suite: 'auth',
    tags: ['smoke', 'auth'],
    authState: 'logged-out',
    goal: `Navigate to /login. Fill in the admin credentials (admin@acme.com / Password123!).
Click the Sign In button. Wait for navigation.
Verify that:
1. The URL changed to /dashboard (or contains "dashboard")
2. The ca_access_token exists in localStorage
Take a screenshot of the dashboard page, then finish_test with your findings.`,
  },

  {
    id: 'AUTH-03',
    name: 'Invalid credentials show error',
    suite: 'auth',
    tags: ['auth'],
    authState: 'logged-out',
    goal: `Navigate to /login.
Fill in: email "wrong@example.com", password "wrongpassword123".
Click Sign In.
Verify that:
1. We stay on the /login page (URL still contains "login")
2. An error message is visible (e.g. "Invalid credentials", "incorrect", "unauthorized", or similar)
Take a screenshot, then finish_test with your findings.`,
  },

  {
    id: 'AUTH-04',
    name: 'Protected route redirects unauthenticated user',
    suite: 'auth',
    tags: ['auth'],
    authState: 'logged-out',
    goal: `First clear localStorage (call clear_local_storage).
Then navigate to /pools (a protected page).
Verify that the browser redirected to /login (URL contains "login").
Finish with pass if redirect happened, fail if we stayed on /pools.`,
  },

  {
    id: 'AUTH-05',
    name: 'JWT token is stored after login',
    suite: 'auth',
    tags: ['auth'],
    authState: 'logged-out',
    goal: `Navigate to /login and log in with admin@acme.com / Password123!.
After successful login (URL changes to dashboard), check localStorage:
- ca_access_token should be present and non-null
- ca_refresh_token should be present and non-null (optional — only if app stores it)
Report what tokens are stored. Pass if ca_access_token is present.`,
  },
];
