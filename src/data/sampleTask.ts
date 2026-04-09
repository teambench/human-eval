import { TaskConfig } from '../types';

// A simplified demo task for testing the interface
export const SAMPLE_TASK: TaskConfig = {
  taskId: 'DEMO_api_fix',
  category: 'API Design',
  difficulty: 'medium',
  timeLimit: 1800, // 30 minutes
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
    """v1 endpoint should return { users: [...] } format"""
    resp = client.get("/v1/users")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "users" in data
    assert len(data["users"]) == 3

def test_v1_get_user(client):
    """v1 endpoint should return user_id and user_name fields"""
    resp = client.get("/v1/users/1")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "user_id" in data
    assert "user_name" in data

def test_v1_auth_should_not_exist(client):
    """v1 auth endpoint must NOT exist (security requirement)"""
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

## Running
\`\`\`
pip install flask
python -m src.server
\`\`\`
`,
    },
  ],
};
