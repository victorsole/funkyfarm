SELECT json_build_object(
  'users', (SELECT count(*) FROM funkyfarmers.users),
  'workspaces', (SELECT count(*) FROM funkyfarmers.workspaces),
  'memberships', (SELECT count(*) FROM funkyfarmers.memberships),
  'records', (SELECT count(*) FROM funkyfarmers.records),
  'record_history', (SELECT count(*) FROM funkyfarmers.record_history),
  'idempotency_keys', (SELECT count(*) FROM funkyfarmers.idempotency_keys),
  'user_preferences', (SELECT count(*) FROM funkyfarmers.user_preferences),
  'public_content', (SELECT count(*) FROM funkyfarmers.public_content),
  'community_reviewers', (SELECT count(*) FROM funkyfarmers.community_reviewers)
);
