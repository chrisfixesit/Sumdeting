# Tutor prompt eval

`tutor_eval.py` scores the tutor's Socratic behaviour against a set of tricky
cases (right-answer-but-flawed-step, wrong answer, clean-correct, and "just
tell me the answer"). Use it to check a `backend/tutor.mjs` prompt change
*before* it reaches students.

## Run

```bash
# after deploying the prompt change (it hits the live /api)
python3 eval/tutor_eval.py

# or against another environment
BASE_URL=https://staging.example.com python3 eval/tutor_eval.py

# or a prompt change before deploying: the local container, which listens on
# 127.0.0.1 only and uses your own AWS credentials (see compose.yaml)
# Its own project name keeps it apart from a running dev container; if that
# container holds port 8080, the start fails and the eval is skipped.
if docker compose -p sumdeting-eval up -d --build \
  && curl -sf --retry 30 --retry-delay 2 --retry-all-errors http://localhost:8080/healthz >/dev/null; then
  API_URL=http://localhost:8080/api/chat python3 eval/tutor_eval.py
else
  echo "Eval server did not start; see docker compose -p sumdeting-eval logs" >&2
fi
docker compose -p sumdeting-eval down
```

It prints each reply next to its pass-criteria. Judging is by reading —
tutor replies are non-deterministic, so there's no exact-match assertion; a
case passes only if every point in its CRITERION holds. Paste the output into
an LLM judge to automate scoring.

## Why it calls the deployed API (not Bedrock directly)

The system prompt lives in the deployed Lambda, and only the Lambda's role has
Bedrock model access. Requests are SigV4-signed by CloudFront (Origin Access
Control) to the Lambda Function URL, so each POST includes
`x-amz-content-sha256` (the SHA-256 of the body) — the script does this the
same way the browser does.

## History

Added after a live session where the tutor confirmed a student's wrong
intermediate step (`-6+5+9=10`), gave a premature ✅, then contradicted
itself. The eval now covers that exact failure mode (case `C1`).

## Maths accuracy (`math_eval.py`)

`tutor_eval.py` checks behaviour; `math_eval.py` checks the maths. It poses 61
problems from Common Entrance to CAPE as if the tutor had set them, sends a
student answer, and scores the tutor's verdict automatically: ✅ is allowed
only for a verified correct answer, so ✅ on a wrong answer (a false accept)
or none on a right one (a false reject) is a marking error.

- `PROBLEMS`: plain right and wrong answers, some right ones in a second form.
- `TRAPS`: harder marking — the right number by a wrong method, a lost root or
  missing + C, rounding slips (and rounding the question asks for), answers not in
  the form the question asks for, and correct answers by unusual methods or forms.

Every answer key was checked with SymPy. None of the problems come from past papers.

```bash
API_URL=http://localhost:8080/api/chat python3 eval/math_eval.py
RUNS=2 WORKERS=4 OUT=replies.jsonl python3 eval/math_eval.py   # live site
```

It prints accuracy by level and answer type, then every miss with the full
reply. A "hit a snag" or empty reply counts as a failed request, not a maths
error. It exits 1 if there was any miss or failed request, so it can gate a release.
Replies vary, so rerun a single miss a few times before treating it as a regression.
