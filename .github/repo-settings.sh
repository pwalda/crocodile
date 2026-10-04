#!/usr/bin/env bash
# Applies the repository's security settings with the GitHub CLI, as the
# owner. Safe to run repeatedly. Some settings only exist for public
# repositories (on the free plan): run it once before making the repository
# public, then again right after.
#
#   gh auth login                      # as the repository owner
#   bash .github/repo-settings.sh      # or: bash .github/repo-settings.sh owner/repo
set -uo pipefail

REPO="${1:-pwalda/crocodile}"
failed=0

step() { printf '\n== %s\n' "$1"; }
# api METHOD PATH [gh api args...]: reports instead of stopping on failure.
api() {
  local method=$1 path=$2
  shift 2
  if out=$(gh api -X "$method" "repos/$REPO$path" "$@" 2>&1); then
    echo "   ok: $method $path"
  else
    echo "   FAILED: $method $path"
    echo "$out" | sed 's/^/     /' | head -5
    failed=1
  fi
}
json() { api "$1" "$2" --input -; }

gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first."; exit 1; }
private=$(gh api "repos/$REPO" --jq .private) || exit 1
echo "Repository $REPO ($([ "$private" = true ] && echo private || echo public))"

step 'General: no wiki or projects, tidy branches, merge commits or squash'
api PATCH '' -F has_wiki=false -F has_projects=false -F delete_branch_on_merge=true \
  -F allow_merge_commit=true -F allow_squash_merge=true -F allow_rebase_merge=false \
  -F allow_auto_merge=false -F allow_update_branch=true

step 'Dependabot alerts and security updates'
api PUT /vulnerability-alerts
api PUT /automated-security-fixes

step 'Actions: read-only token, no PR approvals by Actions'
json PUT /actions/permissions/workflow <<'EOF'
{ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": false }
EOF

step 'Actions: only GitHub, verified and listed actions, pinned to a commit'
json PUT /actions/permissions <<'EOF'
{ "enabled": true, "allowed_actions": "selected" }
EOF
# A newer option; if GitHub doesn't know it yet, the rest still applies.
json PUT /actions/permissions <<'EOF'
{ "enabled": true, "allowed_actions": "selected", "sha_pinning_required": true }
EOF
json PUT /actions/permissions/selected-actions <<'EOF'
{
  "github_owned_allowed": true,
  "verified_allowed": true,
  "patterns_allowed": ["pnpm/action-setup@*", "contributor-assistant/github-action@*"]
}
EOF

step 'Actions: workflows from outside contributors wait for approval'
json PUT /actions/permissions/fork-pr-contributor-approval <<'EOF'
{ "approval_policy": "all_external_contributors" }
EOF

if [ "$private" = true ]; then
  cat <<'EOF'

== Not yet: secret scanning, push protection, private vulnerability
   reporting and the branch and tag rulesets need a public repository on
   the free plan. Make the repository public, then run this script again.
EOF
else
  step 'Secret scanning with push protection'
  json PATCH '' <<'EOF'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
EOF

  step 'Private vulnerability reporting (see .github/SECURITY.md)'
  api PUT /private-vulnerability-reporting

  step 'Ruleset for main: changes go through a PR with green CI'
  ruleset() {
    local name=$1 body id
    body=$(cat)
    id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id" 2>/dev/null)
    if [ -n "$id" ]; then json PUT "/rulesets/$id" <<<"$body"; else json POST /rulesets <<<"$body"; fi
  }
  ruleset main <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "Typecheck, lint and tests" },
          { "context": "Electron end-to-end (packaged)" },
          { "context": "Desktop build (ubuntu-latest)" },
          { "context": "Desktop build (windows-latest)" },
          { "context": "Desktop build (macos-latest)" },
          { "context": "Server bundles" },
          { "context": "Analyze (javascript-typescript)" },
          { "context": "Analyze (actions)" },
          { "context": "cla" }
        ]
      }
    }
  ]
}
EOF

  step 'Ruleset for release tags: only admins create them; nobody moves or deletes them'
  ruleset 'release tags' <<'EOF'
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }]
}
EOF
fi

echo
if [ "$failed" = 0 ]; then echo 'All settings applied.'; else echo 'Some settings failed; see above.'; fi
exit "$failed"
