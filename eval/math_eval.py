#!/usr/bin/env python3
"""
SumDeTing maths-accuracy eval: does the tutor mark answers right?

The tutor never hands out answers, so its maths shows up in one decision: when
a student proposes an answer, it opens with ✅ only if its own working agrees
(see "Verify before you confirm" in backend/tutor.mjs). That makes the verdict
machine-checkable. Each problem below is posed as if the tutor had set it, then
the student replies with:

  right  - the correct answer (sometimes in a second, equivalent form)  -> expect ✅
  wrong  - a plausible mistake (sign slip, wrong rule, extra root ...)  -> expect no ✅

A false accept (✅ on a wrong answer) is the costly error: the student leaves
believing a mistake. A false reject discourages a student who was right.

Every answer key was checked with SymPy before going in. The problems are
written for this eval; none are taken from past papers.

    API_URL=http://localhost:8080/api/chat python3 eval/math_eval.py
    RUNS=3 WORKERS=4 OUT=replies.jsonl python3 eval/math_eval.py

RUNS repeats every case (replies vary run to run), WORKERS sets parallel
requests, OUT saves every reply as JSON lines for reading afterwards.
"""
import json
import os
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

from tutor_eval import API, call

# (level, topic, problem, right answers, wrong answer)
PROBLEMS = [
    # Common Entrance
    ("CE", "Fractions", "Find 3/4 of 56.", ["42"], "14"),
    ("CE", "Percentages & Money", "A shirt costs $80. In a sale it is reduced by 15%. "
     "What is the sale price?", ["$68"], "$65"),
    ("CE", "Ratio", "Share $90 between Ann and Ben in the ratio 2 : 3. How much does "
     "Ben get?", ["$54"], "$60"),
    ("CE", "Measurement", "Find the area of a triangle with base 12 cm and height 7 cm.",
     ["42 cm²"], "84 cm²"),
    ("CE", "Decimals", "Work out 2.4 × 0.3.", ["0.72"], "7.2"),
    ("CE", "Time", "A bus leaves Bridgetown at 9:45 a.m. The journey takes 1 hour "
     "35 minutes. At what time does it arrive?", ["11:20 a.m."], "11:10 a.m."),
    ("CE", "Statistics", "Find the mean of 4, 7, 9, 12 and 13.", ["9"], "11.25"),
    ("CE", "Measurement", "A rectangle is 8 cm long and 5.5 cm wide. Find its perimeter.",
     ["27 cm"], "44 cm"),
    # CSEC
    ("CSEC", "Algebra", "Solve 2x² − 7x + 3 = 0.",
     ["x = 3 or x = 1/2", "x = 0.5 or x = 3"], "x = −3 or x = −1/2"),
    ("CSEC", "Algebra", "Solve the simultaneous equations 3x + 2y = 12 and x − y = −1.",
     ["x = 2, y = 3"], "x = 3, y = 1.5"),
    ("CSEC", "Consumer Arithmetic", "$5000 is invested at 4% per annum compound "
     "interest, compounded annually. Find the interest earned after 2 years.",
     ["$408"], "$400"),
    ("CSEC", "Algebra", "Make r the subject of the formula V = (1/3)πr²h.",
     ["r = √(3V/(πh))"], "r = √(V/(3πh))"),
    ("CSEC", "Coordinate Geometry", "Find the gradient of the line through (−2, 5) and "
     "(4, −7).", ["−2"], "2"),
    ("CSEC", "Geometry", "A right-angled triangle has shorter sides 9 cm and 12 cm. Find "
     "the length of the hypotenuse.", ["15 cm"], "21 cm"),
    ("CSEC", "Trigonometry", "A pole 8 m tall casts a shadow 15 m long on level ground. "
     "Find the angle of elevation of the sun, to 1 decimal place.", ["28.1°"], "61.9°"),
    ("CSEC", "Algebra", "Factorise completely 6x² − x − 2.",
     ["(3x − 2)(2x + 1)", "(2x + 1)(3x − 2)"], "(3x + 2)(2x − 1)"),
    ("CSEC", "Probability", "A bag holds 5 red and 3 blue balls. Two are taken out "
     "without replacement. Find the probability that both are red.",
     ["5/14", "20/56"], "25/64"),
    ("CSEC", "Functions", "Given f(x) = 2x − 3 and g(x) = x², find fg(2).", ["5"], "1"),
    ("CSEC", "Measurement", "A cylinder has radius 7 cm and height 10 cm. Using π = 22/7, "
     "find its volume.", ["1540 cm³"], "440 cm³"),
    ("CSEC", "Functions", "Given f(x) = (3x + 1)/2, find f⁻¹(x).",
     ["f⁻¹(x) = (2x − 1)/3"], "f⁻¹(x) = (2x + 1)/3"),
    # Additional Mathematics
    ("Additional Maths", "Calculus", "Differentiate y = (3x² − 1)⁵ with respect to x.",
     ["dy/dx = 30x(3x² − 1)⁴"], "dy/dx = 5(3x² − 1)⁴"),
    ("Additional Maths", "Calculus", "Evaluate ∫₀² (3x² + 2x) dx.", ["12"], "16"),
    ("Additional Maths", "Sequences & Series", "Find the sum of the first 20 terms of the "
     "arithmetic series 5 + 8 + 11 + …", ["670"], "700"),
    ("Additional Maths", "Indices & Logarithms", "Solve 2^(x+1) = 32.", ["x = 4"], "x = 5"),
    ("Additional Maths", "Indices & Logarithms", "Solve log₃x + log₃(x − 2) = 1.",
     ["x = 3"], "x = 3 or x = −1"),
    ("Additional Maths", "Algebra", "Find the remainder when x³ − 2x² + 4x − 5 is divided "
     "by (x − 2).", ["3"], "−29"),
    ("Additional Maths", "Trigonometry", "Given that sin θ = 3/5 and θ is acute, find the "
     "exact value of sin 2θ.", ["24/25"], "6/5"),
    ("Additional Maths", "Calculus", "Find the coordinates of the stationary point on the "
     "curve y = x² − 6x + 11.", ["(3, 2)"], "(−3, 38)"),
    # CAPE
    ("CAPE Unit 1", "Limits", "Find lim (x→0) of sin(3x)/x.", ["3"], "1"),
    ("CAPE Unit 1", "Calculus", "Differentiate y = x e^(2x) with respect to x.",
     ["dy/dx = e^(2x)(1 + 2x)", "dy/dx = e^(2x) + 2x e^(2x)"], "dy/dx = 2x e^(2x)"),
    ("CAPE Unit 2", "Integration", "Find ∫ x cos x dx.",
     ["x sin x + cos x + C"], "x sin x − cos x + C"),
    ("CAPE Unit 2", "Complex Numbers", "Express z = 1 + i√3 in modulus-argument form.",
     ["z = 2(cos(π/3) + i sin(π/3))"], "z = 2(cos(π/6) + i sin(π/6))"),
    ("CAPE Unit 2", "Matrices", "Find the determinant of the matrix with rows (2, 1, 0), "
     "(1, 3, 2) and (0, 2, 1).", ["−3"], "3"),
    ("CAPE Unit 2", "Sequences & Series", "Find Σ (r = 1 to n) of r(r + 1), in terms of n, "
     "in its simplest factorised form.", ["n(n + 1)(n + 2)/3"], "n(n + 1)(2n + 1)/6"),
    ("CAPE Unit 2", "Differential Equations", "Solve dy/dx = 2xy given that y = 3 when "
     "x = 0.", ["y = 3e^(x²)"], "y = e^(x²) + 2"),
    ("CAPE Unit 1", "Algebra", "Express (5x + 1)/((x − 1)(x + 2)) in partial fractions.",
     ["2/(x − 1) + 3/(x + 2)"], "3/(x − 1) + 2/(x + 2)"),
]


# Harder marking: the answer alone doesn't settle it. Each student reply carries
# its expected verdict: True = deserves ✅, False = must not get one.
# (level, topic, problem, [(student reply, deserves ✅, what it tests)])
TRAPS = [
    ("CSEC", "Measurement", "Find the area of a circle of radius 2 cm, in terms of π.",
     [("A = 2πr = 2 × π × 2 = 4π cm²", False, "right number, circumference formula")]),
    ("Additional Maths", "Calculus", "Find the gradient of y = (3x − 1)² at x = 1/3.",
     [("dy/dx = 2(3x − 1), so at x = 1/3 it is 2(0) = 0", False,
       "right value, chain rule factor missing")]),
    ("CSEC", "Algebra", "Solve x² = 9x.",
     [("divide both sides by x: x = 9", False, "lost root x = 0"),
      ("x² − 9x = 0, x(x − 9) = 0, so x = 0 or x = 9", True, "complete")]),
    ("CSEC", "Algebra", "Solve x² − 5x + 6 = 0.",
     [("(x − 5/2)² − 25/4 + 6 = 0, so (x − 5/2)² = 1/4, x − 5/2 = ±1/2, x = 3 or x = 2",
       True, "completing the square instead of factorising")]),
    ("CSEC", "Trigonometry", "A pole 8 m tall casts a shadow 15 m long on level ground. "
     "Find the angle of elevation of the sun, to 1 decimal place.",
     [("tan θ = 8/15, θ = 28.2°", False, "rounding slip (28.07…)")]),
    ("CSEC", "Measurement", "A circle has circumference 50 cm. Find its area, to 1 decimal "
     "place.",
     [("r = 50 ÷ 2π = 8.0 cm, so A = π × 8.0² = 201.1 cm²", False, "premature rounding"),
      ("r = 25/π, so A = π(25/π)² = 625/π = 198.9 cm²", True, "exact working")]),
    ("Additional Maths", "Trigonometry", "Solve 2 sin x = 1 for 0° ≤ x ≤ 360°.",
     [("sin x = 1/2, x = 30°", False, "missed 150°"),
      ("sin x = 1/2, so x = 30° or x = 150°", True, "complete")]),
    ("Additional Maths", "Calculus", "Find ∫ 6x² dx.",
     [("2x³", False, "missing + C")]),
    ("Additional Maths", "Indices & Logarithms", "Solve 3^(2x) − 4(3^x) + 3 = 0.",
     [("let u = 3^x: u² − 4u + 3 = 0, u = 3, so x = 1", False, "dropped u = 1"),
      ("let u = 3^x: (u − 1)(u − 3) = 0, u = 1 or 3, so x = 0 or x = 1", True,
       "complete")]),
    ("CSEC", "Consumer Arithmetic", "A TV costs $2400 cash. On hire purchase you pay a 20% "
     "deposit and 12 monthly payments of $180. How much more does hire purchase cost?",
     [("deposit $480, payments $2160, total $2640, so $240 more", True, "multi-step"),
      ("12 × 180 = 2160 plus 480 = $2640", False, "total, not the difference")]),
    ("CSEC", "Statistics", "Find the median of 3, 9, 4, 7, 12, 5.",
     [("the middle two are 4 and 7, so the median is 5.5", False, "didn't sort"),
      ("3, 4, 5, 7, 9, 12: (5 + 7) ÷ 2 = 6", True, "sorted")]),
    ("CE", "Number", "Work out 487 × 36.",
     [("17532", True, "long multiplication"), ("17432", False, "one digit off")]),
    ("CE", "Decimals", "Work out 3.2 ÷ 0.04.", [("8", False, "decimal place slip")]),
    ("CE", "Fractions", "Work out 2¾ + 1⅚.",
     [("55/12", True, "improper form"), ("3 8/10", False, "added tops and bottoms")]),
    ("Additional Maths", "Sequences & Series", "Find the sum to infinity of the geometric "
     "series with first term 12 and common ratio −1/3.",
     [("12 ÷ (1 − 1/3) = 18", False, "sign of r"), ("12 ÷ (4/3) = 9", True, "correct")]),
    ("CSEC", "Algebra", "Solve |2x − 1| = 5.", [("x = 3", False, "missed x = −2")]),
    ("CSEC", "Algebra", "Solve the inequality 3 − 2x > 7.",
     [("−2x > 4, so x > −2", False, "didn't flip the sign"),
      ("−2x > 4, so x < −2", True, "correct")]),
    ("CAPE Unit 1", "Limits", "Find lim (x→∞) of (3x² + x)/(x² − 5).",
     [("L'Hôpital twice: (6x + 1)/(2x), then 6/2 = 3", True, "valid other method")]),
    ("CAPE Unit 2", "Complex Numbers", "Express z = 1 + i√3 in modulus-argument form.",
     [("z = 2e^(iπ/3)", True, "exponential form")]),
    ("CAPE Unit 2", "Integration", "Find ∫ sin x cos x dx.",
     [("−(cos²x)/2 + C", True, "differs from sin²x/2 by a constant"),
      ("−cos(2x)/4 + C", True, "double-angle form")]),
    ("CAPE Unit 2", "Matrices", "Find the inverse of the matrix with rows (2, 1) and "
     "(5, 3).",
     [("A⁻¹ has rows (3, −1) and (−5, 2)", True, "correct"),
      ("A⁻¹ has rows (−3, 1) and (5, −2)", False, "sign of the whole matrix")]),
    ("CAPE Unit 2", "Differential Equations", "Solve dy/dx = y/x given that y = 2 when "
     "x = 1.", [("ln y = ln x + ln 2, so y = 2x", True, "separation of variables")]),
    ("CSEC", "Algebra", "Make r the subject of the formula V = (1/3)πr²h.",
     [("r = √(3V) / √(πh)", True, "split surd")]),
    ("CSEC", "Probability", "A bag holds 5 red and 3 blue balls. Two are taken out without "
     "replacement. Find the probability that both are red, giving your answer as a fraction "
     "in its lowest terms.",
     [("20/56", False, "not in the lowest terms asked for"), ("5/14", True, "lowest terms")]),
    ("CSEC", "Measurement", "(a) Find the radius of a circle with circumference 50 cm, giving "
     "your answer to 1 decimal place. (b) Use your rounded answer to (a) to find the area of "
     "the circle, to 1 decimal place.",
     [("(a) r = 8.0 cm. (b) A = π × 8.0² = 201.1 cm²", True,
       "question says to use the rounded value")]),
]


def cases():
    for i, (level, topic, problem, rights, wrong) in enumerate(PROBLEMS, 1):
        posed = [{"role": "user", "content": f"give me one {level} {topic} problem"},
                 {"role": "assistant", "content": f"{problem} Show your working."}]
        for kind, answer in [("right", a) for a in rights] + [("wrong", wrong)]:
            yield {"id": f"P{i:02d}", "level": level, "topic": topic, "problem": problem,
                   "kind": kind, "answer": answer,
                   "messages": posed + [{"role": "user", "content": answer}]}
    for i, (level, topic, problem, replies) in enumerate(TRAPS, 1):
        posed = [{"role": "user", "content": f"give me one {level} {topic} problem"},
                 {"role": "assistant", "content": f"{problem} Show your working."}]
        for answer, deserves, tests in replies:
            yield {"id": f"T{i:02d}", "level": level, "topic": f"{topic} ({tests})",
                   "problem": problem, "kind": "tricky right" if deserves else "tricky wrong",
                   "answer": answer, "messages": posed + [{"role": "user", "content": answer}]}


def run(case):
    try:
        reply = call(case["messages"]).strip()
    except Exception as exc:  # noqa: BLE001 - count transport/API errors, don't abort the run
        return {**case, "reply": f"[ERROR] {exc}", "error": True, "correct": False}
    snag = not reply or "hit a snag" in reply  # empty/failed replies are not maths verdicts
    confirmed = "✅" in reply
    correct = not snag and confirmed == case["kind"].endswith("right")
    return {**case, "reply": reply, "error": snag, "confirmed": confirmed, "correct": correct}


def main():
    runs = int(os.environ.get("RUNS", "1"))
    work = [c for _ in range(runs) for c in cases()]
    print(f"Maths eval against {API}: {len(PROBLEMS) + len(TRAPS)} problems, "
          f"{len(work)} replies\n")
    with ThreadPoolExecutor(int(os.environ.get("WORKERS", "4"))) as pool:
        results = list(pool.map(run, work))

    if os.environ.get("OUT"):
        with open(os.environ["OUT"], "w", encoding="utf-8") as fh:
            for r in results:
                fh.write(json.dumps({k: v for k, v in r.items() if k != "messages"},
                                    ensure_ascii=False) + "\n")

    tally = defaultdict(lambda: [0, 0])
    for r in results:
        if r["error"]:
            continue
        for key in (r["level"], f"{r['kind']} answers", "ALL"):
            tally[key][0] += r["correct"]
            tally[key][1] += 1
    for key, (good, total) in tally.items():
        print(f"{key:<22} {good:>3}/{total:<3} {100 * good / total:5.1f}%")

    errors = [r for r in results if r["error"]]
    misses = [r for r in results if not r["correct"] and not r["error"]]
    if errors:
        print(f"\n{len(errors)} request(s) failed (not scored as maths): "
              + ", ".join(r["id"] for r in errors))
    for r in misses:
        label = "FALSE ACCEPT (✅ on a wrong answer)" if r["kind"].endswith("wrong") \
            else "FALSE REJECT (no ✅ on a right answer)"
        print("\n" + "=" * 72)
        print(f"{r['id']} {r['level']} · {r['topic']} — {label}")
        print(f"Problem: {r['problem']}\nStudent: {r['answer']}")
        print("-" * 72)
        print(r["reply"])
    return 1 if misses or errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
