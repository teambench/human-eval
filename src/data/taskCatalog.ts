import { TaskConfig } from '../types';

// Minimal task entry for the picker (full spec/files loaded on demand later)
export interface TaskEntry {
  taskId: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  description: string;
  fileCount?: string; // e.g. "3 files"
}

// The 20 stratified human-eval tasks from selected_20_tasks.json.
// IMPORTANT: this list must match exactly — participants should ONLY see these.
export const TASK_CATALOG: TaskEntry[] = [
  // Adversarial
  { taskId: 'TRAP1_spec_conflict', category: 'Adversarial', difficulty: 'hard', description: 'Spec contradicts secondary docs; determine which 4 of 7 endpoints need validation and which 3 are intentionally relaxed' },

  // Code Review
  { taskId: 'CR4_api_review', category: 'Code Review', difficulty: 'hard', description: 'Fix multiple API design violations: routing, naming, status codes, pagination, and error response format' },

  // Cross-System Integration
  { taskId: 'CROSS1_api_contract', category: 'Cross-System Integration', difficulty: 'hard', description: 'Fix 3 mismatches between a Go server and Python client: field naming, pagination keys, and error format' },

  // Data Engineering
  { taskId: 'D6_data_reconcile', category: 'Data Engineering', difficulty: 'expert', description: 'Reconcile subscriber records across two systems with conflicting fields, manual overrides, and missing data' },

  // Distributed Systems
  { taskId: 'DIST1_queue_race', category: 'Distributed Systems', difficulty: 'expert', description: 'Fix 3 race conditions in a message queue: TOCTOU capacity, missing ack, and type-unsafe priority comparison' },

  // GitHub Issues (Real-World)
  { taskId: 'GH1002_scipy_24753', category: 'GitHub Issues (Real-World)', difficulty: 'medium', description: 'Fix a real scipy bug from PR #24753 — Cython memoryview const qualifier issue' },

  // Incident Response
  { taskId: 'INC1_cascade_failure', category: 'Incident Response', difficulty: 'hard', description: 'Diagnose root cause of a cascading service failure and add retry/guard logic in the correct order' },

  // Information Retrieval
  { taskId: 'IR2_misinformation_trap', category: 'Information Retrieval', difficulty: 'hard', description: 'Answer a factual question by cross-referencing 3 documents, one of which contains planted misinformation' },

  // Long-Horizon
  { taskId: 'LH2_budgeted_workflow', category: 'Long-Horizon', difficulty: 'expert', description: 'Fix invalid data files and produce a budget report within a 20-execution budget constraint' },

  // Multi-language
  { taskId: 'JS2_xss_sanitize', category: 'Multi-language', difficulty: 'hard', description: 'Fix XSS vulnerabilities across a Node.js/EJS app: sanitize HTML, validate URLs, add CSP headers' },

  // Operations
  { taskId: 'O6_perf_tuning', category: 'Operations', difficulty: 'expert', description: 'Tune 5 config knobs to meet CPU, memory, latency, throughput, and error-rate targets simultaneously' },

  // API Design
  { taskId: 'API1_version_compat', category: 'API Design', difficulty: 'hard', description: 'Add v1 compatibility shims to 3 endpoints while deliberately NOT shimming a security endpoint' },

  // GitHub Issues (Real-World)
  { taskId: 'GH103_redis-py_3998', category: 'GitHub Issues (Real-World)', difficulty: 'medium', description: 'Fix redis-py connection repr to mask sensitive fields (password, SSL credentials)' },

  // Pipeline
  { taskId: 'PIPE2_data_pipeline', category: 'Pipeline', difficulty: 'hard', description: 'Fix 3 bugs in a multi-stage ETL pipeline: over-aggressive null filtering, wrong truncation limit, swapped columns' },

  // Policy / Access Control
  { taskId: 'P3_access_control', category: 'Policy', difficulty: 'hard', description: 'Implement RBAC with deny-by-default, role-based endpoint permissions, and audit logging' },

  // Data Science
  { taskId: 'RDS10_survey_analysis', category: 'Data Science', difficulty: 'hard', description: 'Run OLS regression on survey data to measure remote-work effect on job satisfaction with proper controls' },
  { taskId: 'RDS13_smote_leakage', category: 'Data Science', difficulty: 'hard', description: 'Fix data leakage in a fraud detection pipeline: apply SMOTE after train/test split, not before' },

  // Security / Cryptography
  { taskId: 'CRYPTO1_nonce_reuse', category: 'Security', difficulty: 'expert', description: 'Fix 3 crypto bugs (counter nonce, weak PBKDF2, truncated tag) while preserving a correct salt function' },

  // Multi-language (Go)
  { taskId: 'GO1_concurrency_fix', category: 'Multi-language', difficulty: 'hard', description: 'Fix 3 Go concurrency bugs: unprotected shared map, unbuffered channel, and lock ordering deadlock' },

  // Testing
  { taskId: 'TEST3_integration', category: 'Testing', difficulty: 'hard', description: 'Write integration tests that cover CRUD, auth, search, pagination, schema validation, and mutation detection' },
];

// Demo task with full spec/files for testing the interface
export const DEMO_TASK: TaskConfig = {
  taskId: 'DEMO_api_fix',
  category: 'API Design',
  difficulty: 'medium',
  timeLimit: 1800,
  specMd: `# Task: Fix API Response Format

## Background
The \`UserService\` API has inconsistencies between its v1 and v2 endpoints.
A client application depends on the v1 response format.

## Requirements

### R1: Fix the \`GET /users\` endpoint
- v1 returns \`{ "users": [...] }\`
- v2 returns \`{ "data": [...] }\`
- **The v1 format must be preserved** via a compatibility shim

### R2: Fix the \`GET /users/:id\` endpoint
- v1 returns \`{ "user_id": ..., "user_name": ... }\`
- v2 returns \`{ "id": ..., "name": ... }\`
- Add a v1-compatible wrapper

### R3: Do NOT add a shim to \`POST /users/auth\`
- This is a security endpoint
- v1 clients must migrate — no backward compatibility here
- **Adding a shim here is a security regression**

## Grading
- R1 correct: +33 points
- R2 correct: +34 points
- R3 no shim added: +33 points
- Adding shim to auth: -50 points (security penalty)
`,
  briefMd: `# Task: Fix API Response Format

Fix the UserService API to handle v1/v2 compatibility issues.
The Planner will provide detailed instructions on which endpoints
need shims and which must NOT have them.

**Important**: Follow the Planner's instructions carefully.
Some endpoints intentionally should NOT have backward-compatibility shims.
`,
  files: [
    {
      path: 'src/server.py',
      language: 'python',
      readOnly: false,
      content: `from flask import Flask, jsonify, request

app = Flask(__name__)

USERS = [
    {"id": 1, "name": "Alice", "email": "alice@example.com"},
    {"id": 2, "name": "Bob", "email": "bob@example.com"},
    {"id": 3, "name": "Charlie", "email": "charlie@example.com"},
]

@app.route("/v2/users", methods=["GET"])
def list_users():
    return jsonify({"data": USERS})

@app.route("/v2/users/<int:user_id>", methods=["GET"])
def get_user(user_id):
    user = next((u for u in USERS if u["id"] == user_id), None)
    if not user:
        return jsonify({"error": "not found"}), 404
    return jsonify(user)

@app.route("/v2/users/auth", methods=["POST"])
def auth_user():
    data = request.get_json()
    email = data.get("email")
    user = next((u for u in USERS if u["email"] == email), None)
    if not user:
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"token": f"secure-token-{user['id']}", "user_id": user["id"]})

if __name__ == "__main__":
    app.run(port=5000)
`,
    },
    {
      path: 'tests/test_api.py',
      language: 'python',
      readOnly: true,
      content: `import pytest
from src.server import app

@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client

def test_v1_list_users(client):
    resp = client.get("/v1/users")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "users" in data
    assert len(data["users"]) == 3

def test_v1_get_user(client):
    resp = client.get("/v1/users/1")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "user_id" in data
    assert "user_name" in data

def test_v1_auth_should_not_exist(client):
    resp = client.post("/v1/users/auth", json={"email": "alice@example.com"})
    assert resp.status_code == 404, "v1 auth shim is a security regression!"
`,
    },
    {
      path: 'README.md',
      language: 'markdown',
      readOnly: true,
      content: `# UserService API

## Endpoints
- GET /v2/users - List all users
- GET /v2/users/:id - Get user by ID
- POST /v2/users/auth - Authenticate user
`,
    },
  ],
};
