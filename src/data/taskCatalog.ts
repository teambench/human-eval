import { TaskConfig } from '../types';

// Minimal task entry for the picker (full spec/files loaded on demand later).
// `displayName` is the human-readable title shown in the picker and each
// role's header; `taskId` stays as the internal key for Firebase paths,
// grader lookup, localStorage keys, and container staging — so renaming
// only touches display, not wiring.
export interface TaskEntry {
  taskId: string;
  displayName: string;
  category: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  description: string;
  fileCount?: string; // e.g. "3 files"
}

// The 20 stratified human-eval tasks from selected_20_tasks.json.
// IMPORTANT: this list must match exactly — participants should ONLY see these.
export const TASK_CATALOG: TaskEntry[] = [
  // Adversarial
  { taskId: 'TRAP1_spec_conflict', displayName: 'Contradictory API Specs', category: 'Adversarial', difficulty: 'hard', description: 'Spec contradicts secondary docs; determine which 4 of 7 endpoints need validation and which 3 are intentionally relaxed' },

  // Code Review
  { taskId: 'CR4_api_review', displayName: 'API Design Review', category: 'Code Review', difficulty: 'hard', description: 'Fix multiple API design violations: routing, naming, status codes, pagination, and error response format' },

  // Cross-System Integration
  { taskId: 'CROSS1_api_contract', displayName: 'Go/Python API Contract Fix', category: 'Cross-System Integration', difficulty: 'hard', description: 'Fix 3 mismatches between a Go server and Python client: field naming, pagination keys, and error format' },

  // Data Engineering
  { taskId: 'D6_data_reconcile', displayName: 'Subscriber Record Reconciliation', category: 'Data Engineering', difficulty: 'expert', description: 'Reconcile subscriber records across two systems with conflicting fields, manual overrides, and missing data' },

  // Distributed Systems
  { taskId: 'DIST1_queue_race', displayName: 'Message Queue Race Conditions', category: 'Distributed Systems', difficulty: 'expert', description: 'Fix 3 race conditions in a message queue: TOCTOU capacity, missing ack, and type-unsafe priority comparison' },

  // GitHub Issues (Real-World)
  { taskId: 'GH1002_scipy_24753', displayName: 'SciPy Cython Memoryview Fix', category: 'GitHub Issues (Real-World)', difficulty: 'medium', description: 'Fix a real scipy bug from PR #24753 — Cython memoryview const qualifier issue' },

  // Incident Response
  { taskId: 'INC1_cascade_failure', displayName: 'Cascading Service Failure', category: 'Incident Response', difficulty: 'hard', description: 'Diagnose root cause of a cascading service failure and add retry/guard logic in the correct order' },

  // Information Retrieval
  { taskId: 'IR2_misinformation_trap', displayName: 'Misinformation in Multi-Doc QA', category: 'Information Retrieval', difficulty: 'hard', description: 'Answer a factual question by cross-referencing 3 documents, one of which contains planted misinformation' },

  // Long-Horizon
  { taskId: 'LH2_budgeted_workflow', displayName: 'Budgeted Data Workflow', category: 'Long-Horizon', difficulty: 'expert', description: 'Fix invalid data files and produce a budget report within a 20-execution budget constraint' },

  // Multi-language
  { taskId: 'JS2_xss_sanitize', displayName: 'Node.js XSS Sanitization', category: 'Multi-language', difficulty: 'hard', description: 'Fix XSS vulnerabilities across a Node.js/EJS app: sanitize HTML, validate URLs, add CSP headers' },

  // Operations
  { taskId: 'O6_perf_tuning', displayName: 'Five-Knob Performance Tuning', category: 'Operations', difficulty: 'expert', description: 'Tune 5 config knobs to meet CPU, memory, latency, throughput, and error-rate targets simultaneously' },

  // API Design
  { taskId: 'API1_version_compat', displayName: 'v1/v2 API Compatibility Shims', category: 'API Design', difficulty: 'hard', description: 'Add v1 compatibility shims to 3 endpoints while deliberately NOT shimming a security endpoint' },

  // GitHub Issues (Real-World)
  { taskId: 'GH103_redis-py_3998', displayName: 'redis-py Password Masking', category: 'GitHub Issues (Real-World)', difficulty: 'medium', description: 'Fix redis-py connection repr to mask sensitive fields (password, SSL credentials)' },

  // Pipeline
  { taskId: 'PIPE2_data_pipeline', displayName: 'ETL Pipeline Bug Fixes', category: 'Pipeline', difficulty: 'hard', description: 'Fix 3 bugs in a multi-stage ETL pipeline: over-aggressive null filtering, wrong truncation limit, swapped columns' },

  // Policy / Access Control
  { taskId: 'P3_access_control', displayName: 'RBAC Access Control', category: 'Policy', difficulty: 'hard', description: 'Implement RBAC with deny-by-default, role-based endpoint permissions, and audit logging' },

  // Data Science
  { taskId: 'RDS10_survey_analysis', displayName: 'Remote-Work Survey Analysis', category: 'Data Science', difficulty: 'hard', description: 'Run OLS regression on survey data to measure remote-work effect on job satisfaction with proper controls' },
  { taskId: 'RDS13_smote_leakage', displayName: 'SMOTE Data-Leakage Fix', category: 'Data Science', difficulty: 'hard', description: 'Fix data leakage in a fraud detection pipeline: apply SMOTE after train/test split, not before' },

  // Security / Cryptography
  { taskId: 'CRYPTO1_nonce_reuse', displayName: 'AES-GCM Nonce & KDF Fix', category: 'Security', difficulty: 'expert', description: 'Fix 3 crypto bugs (counter nonce, weak PBKDF2, truncated tag) while preserving a correct salt function' },

  // Multi-language (Go)
  { taskId: 'GO1_concurrency_fix', displayName: 'Go Concurrency Bugs', category: 'Multi-language', difficulty: 'hard', description: 'Fix 3 Go concurrency bugs: unprotected shared map, unbuffered channel, and lock ordering deadlock' },

  // Testing
  { taskId: 'TEST3_integration', displayName: 'API Integration Test Suite', category: 'Testing', difficulty: 'hard', description: 'Write integration tests that cover CRUD, auth, search, pagination, schema validation, and mutation detection' },

  // ── N=10 EASY TASKS (added 2026-04-24 per collaborator feedback that
  // the hard/expert-heavy N=20 intimidated participants). Every task
  // here has a verified grade.sh, a seeded generator, and prior
  // ablation-run data, so they're not fresh/unvalidated additions.
  // Ordered to alternate category with the N=20 above for smoother
  // scrolling, and all marked difficulty='easy' so they cluster at
  // the top when the picker sorts by difficulty. ──

  // Data Engineering
  { taskId: 'D8_csv_cleanup', displayName: 'Messy CSV Cleanup', category: 'Data Engineering', difficulty: 'easy', description: 'Clean a messy CSV (stray quotes, inconsistent nulls, bad encoding) using documented data-quality rules; output a normalized file' },

  // Information Retrieval
  { taskId: 'IR1_evidence_qa', displayName: 'Evidence-Based QA', category: 'Information Retrieval', difficulty: 'easy', description: 'Find the final approved budget for a fictional "Titan Initiative" by cross-referencing an offline 3-document corpus; submit JSON with citations' },

  // Testing
  { taskId: 'TEST8_unit_basic', displayName: 'Unit Test Basics', category: 'Testing', difficulty: 'easy', description: 'Fix 3 bugs in mathutils.py and write the missing unit tests that would have caught them' },

  // Code Review
  { taskId: 'CR2_style_enforce', displayName: 'Python Style Enforcement', category: 'Code Review', difficulty: 'easy', description: 'Fix lint/style violations in a small Python module (imports, naming, unused vars, type hints) without changing behavior' },

  // Security
  { taskId: 'S7_env_config', displayName: 'Environment Variable Bugs', category: 'Security', difficulty: 'easy', description: 'Fix env-var handling so the app starts cleanly with no vars set: defaults, type coercion, missing-required errors' },

  // Operations
  { taskId: 'O8_dockerfile_fix', displayName: 'Dockerfile Repair', category: 'Operations', difficulty: 'easy', description: 'Fix a broken Dockerfile for a Python web app: base image, COPY order, EXPOSE port, CMD, working dir' },

  // Policy
  { taskId: 'P6_license_check', displayName: 'License Compatibility Check', category: 'Policy', difficulty: 'easy', description: 'Identify and replace license-incompatible dependencies in requirements.txt using the approved alternatives list' },

  // Real-World GitHub
  { taskId: 'GH16_fiber_cors_logic', displayName: 'Go Fiber CORS Middleware Fix', category: 'GitHub Issues (Real-World)', difficulty: 'easy', description: 'Fix a CORS middleware bug in Go Fiber: OR-vs-AND logic breaks non-preflight requests with multiple headers' },
  { taskId: 'GH15_gin_context_key', displayName: 'Go Gin Context-Key Fix', category: 'GitHub Issues (Real-World)', difficulty: 'easy', description: 'Fix a Go Gin context-key type violation that collides with OpenTelemetry; use a typed key instead of a bare string' },
  { taskId: 'GH1201_mlflow_21832', displayName: 'MLflow Flaky Test Fix', category: 'GitHub Issues (Real-World)', difficulty: 'easy', description: 'Fix a flaky MLflow test (test_create_model_version_with_validation_regex) by disabling background job execution in the fixture' },
];

// Demo task with full spec/files for testing the interface
export const DEMO_TASK: TaskConfig = {
  taskId: 'DEMO_api_fix',
  displayName: 'Demo: API Response Format Fix',
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
