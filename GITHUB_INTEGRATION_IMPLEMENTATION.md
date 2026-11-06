# DeployKit — Phase 1: GitHub Integration Implementation Document

**Date:** November 5, 2026
**Status:** Completed & Verified
**Branch:** `main` (commit `3c175ec`)
**Target Repository:** `/home/manisha/deploykit`

---

## 1. Files Changed & Created

| Path | Status | Purpose |
| :--- | :---: | :--- |
| `apps/web/src/types.ts` | Modified | Added `"github"` to `NavKey` union; added `GitHubLink` type; made `repositoryId` optional in `GitHubSelection`. |
| `apps/web/src/lib/api.ts` | Modified | Enhanced `fetchGitHubRepositories` to safely accept `(pageOrSignal?: number | AbortSignal, signal?: AbortSignal)`; exported `fetchProjectGithubLink`, `unlinkProjectGithub`, and `linkProjectGithub`. |
| `apps/web/src/components/CommandBar.tsx` | Modified | Added GitHub navigation item with `GitBranch` icon to the primary command bar under the `"run"` group. |
| `apps/web/src/components/ServiceHeader.tsx` | Modified | Added auto-deploy badge indicator when a project has continuous deployment enabled. |
| `apps/web/src/App.tsx` | Modified | Imported and mounted `GitHubView` under `nav === "github"` with page title, eyebrow, and live project reload triggers. |
| `apps/web/src/components/GitHubView.tsx` | Created / Integrated | Complete GitHub dashboard view: connection status card, repository browser with search/pagination, linked services list, auto-deploy toggle, and unlink confirmation dialog. |
| `apps/web/src/components/GitHubView.test.tsx` | Created | 10 comprehensive unit tests covering mounting, unconfigured states, popup launch, search filtering, repository linking, unlink confirmation modal, auto-deploy toggle, and network errors. |
| `apps/web/src/App.test.tsx` | Modified | Added GitHub navigation test verifying CommandBar transition and view mounting. |
| `apps/api/src/controllers/githubConnectionController.ts` | Modified | Validated `page` query parameter parsing via Zod. |
| `apps/api/src/infrastructure/github/githubClient.ts` | Modified | Supported GitHub API pagination query parameters for installation repository listing. |
| `apps/api/src/infrastructure/github/githubClient.unit.test.ts` | Modified | Unit tests for paginated repository listing. |
| `apps/api/src/services/githubConnectionService.ts` | Modified | Passed `page` parameter through to GitHub infrastructure client. |

---

## 2. Navigation Changes

- Added `"github"` to the `NavKey` union in `apps/web/src/types.ts`.
- Inserted `{ key: "github", label: "GitHub", icon: GitBranch, group: "run" }` into `CommandBar.tsx`.
- Positioned the navigation tab seamlessly within the primary application bar, accessible via mouse click, touch, and keyboard navigation.
- Preserved existing shortcuts, counts, and active state styles (`bg-ink-700 font-semibold text-white`).
- When navigating to `nav === "github"`, `App.tsx` renders the full GitHub management dashboard with header:
  - **Eyebrow:** `Source control`
  - **Title:** `GitHub integration`
  - **Description:** `Connect your GitHub App to browse repositories and link them to DeployKit services for automatic push deployments.`

---

## 3. GitHub Connection Flow

1. On mount, `GitHubView` calls `fetchGitHubConnection(signal)` against `GET /api/github/connection`.
2. The endpoint verifies user session credentials and queries the server GitHub App configuration:
   - If not configured: Displays an empty state informing the user that server credentials are required.
   - If configured: Renders the connected status badge, callback URL, and a refresh button.
3. If an installation URL is available:
   - Renders the **Connect GitHub App** action button (`DeployBtn`).
   - Clicking opens the backend-provided `installUrl` in a focused popup window (`window.open(connection.installUrl, "deploykit-github", "width=720,height=760")`).
   - The button transitions into a waiting state: `"Waiting for GitHub…"`.
   - The UI actively tracks `connectRef.current.closed`. Once the installation flow completes and closes, `GitHubView` automatically re-fetches the connection and repository list.

---

## 4. Callback Flow

- **Endpoint:** `GET /api/github/callback` (handled by `githubCallbackController.ts`).
- **Validation:**
  - Verifies HMAC state via `verifyGitHubState(state)` to protect against CSRF and expired installation requests.
  - Validates `installation_id` from GitHub.
  - Persists the installation ID into the `github_installations` table via `recordGitHubInstallation()`.
- **Response:**
  - On success: Serves a self-closing HTML page with script `setTimeout(function(){window.close()}, 1200)` and a fallback link to `webOrigin()`.
  - On failure / expiry: Serves an informative error page with a return link back to DeployKit.
- The parent dashboard automatically detects when the popup closes and refreshes both connection status and repository lists.

---

## 5. Repository Browser Functionality

- **Endpoint:** `GET /api/github/repositories?page=<n>` (handled by `listGitHubRepositoriesController.ts`).
- Fetches repositories across all active GitHub App installations.
- **Repository Metadata Displayed:**
  - Repository Full Name (`owner/repo`)
  - Default Branch (with `GitBranch` icon)
  - Visibility Badge: `public` or `private` (with `Lock` icon and custom amber badge styling)
- **Search & Filtering:**
  - Instant client-side text filter by repository name, owner, or full path.
  - Empty search state: `"No repositories match — Try a different filter."`
- **Pagination:**
  - Supports `Prev` and `Next` buttons with page counter (`page 1`).
  - Gracefully detects when repositories are exhausted.
  - Honest indication if any installation could not be reached (`reposFailed > 0`).

---

## 6. Repository Linking Workflow

1. In the **Linked services** panel, all DeployKit projects are listed.
2. For unlinked projects:
   - A dropdown `<select>` is populated with all available repositories.
   - User selects a repository and clicks **Link**.
3. Frontend issues `POST /api/projects/:id/github-link`:
   ```json
   {
     "installationId": "...",
     "repositoryFullName": "owner/repo",
     "repositoryId": 123456,
     "autoDeploy": true
   }
   ```
4. On backend confirmation:
   - UI updates the project row to display the linked repository name.
   - Refreshes project state via `fetchProjectGithubLink` and `onProjectUpdate()`.
   - Triggers toast notification: `"{project.name} linked to {repo.fullName}"`.
   - ServiceHeader displays the linked repository and auto-deploy indicator.

---

## 7. Auto-Deploy Status

- The `projects` table stores `auto_deploy: boolean` (default: `true` upon linking).
- When linked, an interactive `AutoDeployPill` button displays either `auto-deploy on` or `auto-deploy off`.
- Clicking the pill triggers `toggleAutoDeploy()`:
  - Invokes `POST /api/projects/:id/github-link` with `autoDeploy: !currentLink.auto_deploy`.
  - Updates the badge state and fires toast: `"Auto-deploy enabled/disabled for {project.name}"`.
  - `ServiceHeader` reflects continuous deployment status in real time.

---

## 8. Unlinking and Disconnecting

### Unlinking a Project Repository
- Clicking **Unlink** does **NOT** immediately delete the link.
- Opens an accessible, high-contrast confirmation modal (`role="dialog"`, `aria-modal="true"`):
  - **Heading:** `Unlink repository?`
  - **Explanation:** Confirms that unlinking will disable automatic deployments on push, while explicitly guaranteeing that runtime containers, project history, and deployments remain untouched.
  - **Actions:** `Cancel` and `Confirm Unlink`.
- On confirmation, calls `DELETE /api/projects/:id/github-link` (`unlinkProjectGithub`).
- Resets project state to unlinked and fires toast: `"{project.name} unlinked"`.

### Installation Disconnection Notice
- DeployKit does not provide an API endpoint to delete an entire GitHub App installation from the backend database (installations are owned and revoked directly on GitHub).
- In accordance with project instructions, no fake disconnect endpoint was invented. Users manage and revoke installations directly through GitHub's App Settings.

---

## 9. Test Suite & Verification Results

### Frontend Test Suite (`apps/web`)
Ran `npm --prefix apps/web test -- --run`:
- **Test Files:** 9 passed (9 total)
- **Total Tests:** 84 passed (84 total)
- **Duration:** ~2.15 seconds

Tests covering Phase 1:
1. `apps/web/src/components/GitHubView.test.tsx`:
   - `mounts successfully and renders the connected state` (PASS)
   - `renders unconfigured state when GitHub App is not configured on server` (PASS)
   - `connect action launches popup with backend-provided URL` (PASS)
   - `renders repository list with visibility and branch` (PASS)
   - `repository search filters repositories by name or owner` (PASS)
   - `empty repository state renders when no repositories are installed` (PASS)
   - `links a repository to a project and triggers notifications and updates` (PASS)
   - `unlink action opens confirmation dialog and executes unlinking on confirm` (PASS)
   - `auto-deploy button toggles auto-deploy setting` (PASS)
   - `displays useful error when fetching connection fails` (PASS)
2. `apps/web/src/App.test.tsx`:
   - `opens the github integration view from the command bar` (PASS)

### Frontend Build
Ran `npm --prefix apps/web run build`:
- `tsc -b && vite build` succeeded in 568ms with zero TypeScript or linting errors.

### Backend Unit Test Suite (`apps/api`)
Ran `npm --prefix apps/api run test:no-db`:
- **Total Tests:** 744 passed (744 total, 0 failures).

---

## 10. Remaining Limitations & Next Steps

1. **GitHub App Setup Required:** The backend requires valid GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_BASE64`, `GITHUB_WEBHOOK_SECRET`) in `.env` to communicate with GitHub API. Without these, the UI gracefully renders the "GitHub is not configured" state.
2. **Multi-Tenant Installation Scoping:** Currently, `listGitHubRepositories` aggregates all installations stored in the database. When DeployKit adds multi-tenant teams, installations should be filtered by tenant workspace.
3. **Webhook Redelivery UI:** Webhook deliveries are tracked in `github_webhook_deliveries` in the database; a future phase can expose a delivery timeline with manual redelivery triggers in the UI.

---

## 11. Local Execution & Manual Verification Guide

### 1. Start the Backend API & Database
```bash
cd /home/manisha/deploykit
docker compose up -d postgres
npm --prefix apps/api run dev
```

### 2. Start the Frontend Dashboard
```bash
cd /home/manisha/deploykit
npm --prefix apps/web run dev
```

### 3. Open in Browser
Navigate to:
```text
http://localhost:5173
```
- Click the **GitHub** tab in the top navigation bar.
- Review the connection status card.
- If GitHub App is configured, click **Connect GitHub App** to link your repository.
- Link an installed repository to any DeployKit service from the dropdown.
