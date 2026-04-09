import { TaskConfig } from '../types';
import { SAMPLE_TASK } from './sampleTask';

// Additional demo tasks for the task picker
const TASK_DIST_RACE: TaskConfig = {
  taskId: 'DIST1_queue_race',
  category: 'Distributed Systems',
  difficulty: 'hard',
  timeLimit: 2400,
  specMd: `# Task: Fix Race Conditions in Distributed Queue

## Background
A distributed message queue has three race conditions that cause data loss and ordering violations under concurrent access.

## Requirements

### R1: Fix TOCTOU in enqueue
The \`enqueue()\` method checks capacity then adds — but between check and add, another thread can fill the queue. Use atomic compare-and-swap or locking.

### R2: Fix missing acknowledgment in dequeue
\`get()\` removes the message immediately but never sends an ACK. If the consumer crashes, the message is lost. Implement: get() should mark as "in-flight", and only remove on explicit ack().

### R3: Fix type-unsafe priority comparison
Priority queue compares mixed types (int vs string) causing silent ordering bugs. Ensure all priorities are compared as integers.

### R4: Do NOT change the MessageID generation
The current UUID-based ID generation is correct. Changing it would break downstream consumers.

## Grading
- R1 fixed: +25 points
- R2 fixed: +25 points
- R3 fixed: +25 points
- R4 not broken: +25 points (modifying ID generation: -50 points)
`,
  briefMd: `# Task: Fix Race Conditions in Distributed Queue

Fix bugs in the distributed message queue. The Planner will provide details on which specific issues to fix. **Important**: Some parts of the code are correct and must not be changed.
`,
  files: [
    {
      path: 'queue/distributed_queue.py',
      language: 'python',
      readOnly: false,
      content: `import uuid
import threading
from typing import Any, Optional
from dataclasses import dataclass, field
from heapq import heappush, heappop

@dataclass(order=True)
class Message:
    priority: Any  # BUG: mixed int/str comparison
    content: str = field(compare=False)
    message_id: str = field(default_factory=lambda: str(uuid.uuid4()), compare=False)

class DistributedQueue:
    def __init__(self, capacity: int = 100):
        self.capacity = capacity
        self.queue: list[Message] = []
        self.lock = threading.Lock()

    def enqueue(self, content: str, priority: int = 0) -> Optional[str]:
        # BUG: TOCTOU — check and add are not atomic
        if len(self.queue) >= self.capacity:
            return None
        msg = Message(priority=priority, content=content)
        heappush(self.queue, msg)
        return msg.message_id

    def get(self) -> Optional[Message]:
        # BUG: no ack mechanism — message lost if consumer crashes
        if not self.queue:
            return None
        return heappop(self.queue)

    def size(self) -> int:
        return len(self.queue)
`,
    },
    {
      path: 'tests/test_queue.py',
      language: 'python',
      readOnly: true,
      content: `import threading
from queue.distributed_queue import DistributedQueue

def test_concurrent_enqueue():
    """Multiple threads should not exceed capacity"""
    q = DistributedQueue(capacity=10)
    results = []
    def enqueue_one(i):
        result = q.enqueue(f"msg-{i}", priority=i)
        results.append(result)
    threads = [threading.Thread(target=enqueue_one, args=(i,)) for i in range(20)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert q.size() <= 10, f"Queue exceeded capacity: {q.size()}"

def test_ack_mechanism():
    """Messages should not be lost without explicit ack"""
    q = DistributedQueue()
    q.enqueue("important", priority=1)
    msg = q.get()
    assert msg is not None
    # Without ack, message should still be recoverable
    assert q.size() == 1 or hasattr(q, 'in_flight')

def test_priority_ordering():
    """Priorities must be compared as integers"""
    q = DistributedQueue()
    q.enqueue("low", priority=10)
    q.enqueue("high", priority=1)
    q.enqueue("med", priority=5)
    msg = q.get()
    assert msg.priority == 1, f"Expected priority 1, got {msg.priority}"
`,
    },
    {
      path: 'README.md',
      language: 'markdown',
      readOnly: true,
      content: `# Distributed Message Queue

A priority-based distributed message queue with threading support.

## Usage
\`\`\`python
from queue.distributed_queue import DistributedQueue
q = DistributedQueue(capacity=100)
msg_id = q.enqueue("hello", priority=1)
msg = q.get()
\`\`\`
`,
    },
  ],
};

const TASK_SEC_AUTH: TaskConfig = {
  taskId: 'SEC1_auth_bypass',
  category: 'Security',
  difficulty: 'hard',
  timeLimit: 2400,
  specMd: `# Task: Fix Authentication Bypass Vulnerabilities

## Background
A REST API authentication module has multiple security flaws allowing unauthorized access.

## Requirements

### R1: Fix JWT algorithm confusion
The \`verify_token()\` function accepts "none" algorithm. Restrict to HS256 only.

### R2: Fix timing-unsafe password comparison
\`check_password()\` uses \`==\` for comparing hashes, enabling timing attacks. Use \`hmac.compare_digest()\`.

### R3: Fix missing rate limiting on login
The \`/login\` endpoint has no rate limiting. Add a simple per-IP counter that blocks after 5 attempts in 60 seconds.

### R4: Do NOT modify the session token format
The current session token format (base64-encoded JSON) is used by mobile clients. Changing the format would break them.

## Grading
- R1 fixed: +25 points
- R2 fixed: +25 points
- R3 implemented: +25 points
- R4 not broken: +25 points
`,
  briefMd: `# Task: Fix Authentication Bypass Vulnerabilities

Fix security issues in the authentication module. The Planner will specify which vulnerabilities to fix. **Important**: Some token formats must remain unchanged for backward compatibility.
`,
  files: [
    {
      path: 'auth/handler.py',
      language: 'python',
      readOnly: false,
      content: `import jwt
import hmac
import hashlib
import base64
import json
import time
from typing import Optional

SECRET_KEY = "super-secret-key-change-in-prod"

def create_token(user_id: str, role: str) -> str:
    payload = {
        "user_id": user_id,
        "role": role,
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")

def verify_token(token: str) -> Optional[dict]:
    # BUG: accepts "none" algorithm
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=["HS256", "none"])
    except jwt.InvalidTokenError:
        return None

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def check_password(stored_hash: str, provided_password: str) -> bool:
    # BUG: timing-unsafe comparison
    return stored_hash == hash_password(provided_password)

def create_session_token(user_data: dict) -> str:
    """Session token format — DO NOT CHANGE (mobile clients depend on this)"""
    return base64.b64encode(json.dumps(user_data).encode()).decode()

def verify_session_token(token: str) -> Optional[dict]:
    try:
        return json.loads(base64.b64decode(token).decode())
    except Exception:
        return None
`,
    },
    {
      path: 'auth/routes.py',
      language: 'python',
      readOnly: false,
      content: `from flask import Flask, request, jsonify
from auth.handler import verify_token, check_password, create_token, hash_password

app = Flask(__name__)

# In-memory user store
USERS = {
    "admin": {"password_hash": hash_password("admin123"), "role": "admin"},
    "user1": {"password_hash": hash_password("pass456"), "role": "user"},
}

@app.route("/login", methods=["POST"])
def login():
    # BUG: no rate limiting
    data = request.get_json()
    username = data.get("username", "")
    password = data.get("password", "")

    user = USERS.get(username)
    if not user or not check_password(user["password_hash"], password):
        return jsonify({"error": "unauthorized"}), 401

    token = create_token(username, user["role"])
    return jsonify({"token": token})

@app.route("/protected", methods=["GET"])
def protected():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return jsonify({"error": "missing token"}), 401

    payload = verify_token(auth[7:])
    if not payload:
        return jsonify({"error": "invalid token"}), 401

    return jsonify({"message": f"Hello {payload['user_id']}", "role": payload["role"]})
`,
    },
    {
      path: 'tests/test_auth.py',
      language: 'python',
      readOnly: true,
      content: `import jwt
from auth.handler import verify_token, check_password, hash_password

def test_none_algorithm_rejected():
    """Tokens with 'none' algorithm must be rejected"""
    fake_token = jwt.encode({"user_id": "hacker", "role": "admin"}, None, algorithm="none")
    result = verify_token(fake_token)
    assert result is None, "none algorithm should be rejected"

def test_timing_safe_comparison():
    """Password comparison should use constant-time comparison"""
    import inspect
    source = inspect.getsource(check_password)
    assert "compare_digest" in source, "Must use hmac.compare_digest"

def test_session_token_format_unchanged():
    """Session token format must remain base64 JSON"""
    from auth.handler import create_session_token, verify_session_token
    token = create_session_token({"user_id": "test", "role": "user"})
    result = verify_session_token(token)
    assert result["user_id"] == "test"
`,
    },
  ],
};

const TASK_DATA_LEAKAGE: TaskConfig = {
  taskId: 'DS1_feature_leakage',
  category: 'Data Science',
  difficulty: 'medium',
  timeLimit: 1800,
  specMd: `# Task: Fix Feature Leakage in ML Pipeline

## Background
A machine learning pipeline for loan default prediction has feature leakage — information from the target variable leaks into the training features, causing artificially high accuracy that won't generalize.

## Requirements

### R1: Remove \`payment_status\` from features
This column is derived from the target variable (default/no-default) and won't be available at prediction time. Remove it from the feature set.

### R2: Fix temporal leakage in train/test split
The current random split allows future data to leak into training. Use a temporal split: train on data before 2023, test on 2023+.

### R3: Move scaling AFTER the split
StandardScaler is currently fit on the entire dataset, then split. The scaler must be fit ONLY on training data, then transform both train and test.

### R4: Do NOT remove \`credit_score\`
Credit score is a legitimate feature available at prediction time. Removing it would hurt model performance.

## Grading
- R1 fixed: +25 points
- R2 fixed: +25 points
- R3 fixed: +25 points
- R4 not removed: +25 points
`,
  briefMd: `# Task: Fix Feature Leakage in ML Pipeline

Fix data leakage issues in the loan default prediction pipeline. The Planner will specify which features and preprocessing steps need to be fixed. **Important**: Not all features are problematic — some must be kept.
`,
  files: [
    {
      path: 'pipeline/train.py',
      language: 'python',
      readOnly: false,
      content: `import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report

def load_data():
    np.random.seed(42)
    n = 1000
    data = pd.DataFrame({
        'credit_score': np.random.randint(300, 850, n),
        'income': np.random.normal(60000, 20000, n),
        'debt_ratio': np.random.uniform(0, 1, n),
        'loan_amount': np.random.normal(25000, 10000, n),
        'payment_status': np.random.choice(['current', 'late', 'default'], n),  # LEAKS TARGET
        'application_date': pd.date_range('2020-01-01', periods=n, freq='D'),
        'default': np.random.binomial(1, 0.2, n),
    })
    # payment_status is derived from default — it's the leak
    data.loc[data['default'] == 1, 'payment_status'] = 'default'
    return data

def train_model():
    data = load_data()

    features = ['credit_score', 'income', 'debt_ratio', 'loan_amount', 'payment_status']

    # Encode payment_status
    data['payment_status'] = data['payment_status'].map({'current': 0, 'late': 1, 'default': 2})

    X = data[features]
    y = data['default']

    # BUG: scaling before split leaks test distribution into training
    scaler = StandardScaler()
    X = pd.DataFrame(scaler.fit_transform(X), columns=features)

    # BUG: random split ignores temporal ordering
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    print(f"Accuracy: {accuracy_score(y_test, y_pred):.3f}")
    print(classification_report(y_test, y_pred))
    return model

if __name__ == "__main__":
    train_model()
`,
    },
    {
      path: 'tests/test_pipeline.py',
      language: 'python',
      readOnly: true,
      content: `import inspect
from pipeline.train import train_model, load_data

def test_no_payment_status():
    """payment_status should not be in features"""
    source = inspect.getsource(train_model)
    assert 'payment_status' not in source.split('features = ')[1].split(']')[0], \\
        "payment_status should be removed from features"

def test_credit_score_present():
    """credit_score is a legitimate feature and must be kept"""
    source = inspect.getsource(train_model)
    assert 'credit_score' in source, "credit_score must remain in features"

def test_temporal_split():
    """Should use temporal split, not random"""
    source = inspect.getsource(train_model)
    assert 'train_test_split' not in source or 'application_date' in source, \\
        "Must use temporal split based on application_date"
`,
    },
  ],
};

// All available tasks
export const TASK_CATALOG: TaskConfig[] = [
  SAMPLE_TASK,
  TASK_DIST_RACE,
  TASK_SEC_AUTH,
  TASK_DATA_LEAKAGE,
];
