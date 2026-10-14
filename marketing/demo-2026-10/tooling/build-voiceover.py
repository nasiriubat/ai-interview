import re, os
OUT = "/Users/mhnash/Desktop/projects/ai-interview/.claude/worktrees/agent-a0d17a8667c5ce565/marketing/demo-2026-10/voiceover"
os.makedirs(OUT, exist_ok=True)

# (id, seconds, [screenshots], text with cues)
FULL = [
 ("S1", 9, ["landing/01-landing-hero.png"],
  "(warm) Before you decide what to build, [pause 0.4s] find out what the problem actually is. [beat] That is what this does."),
 ("S2", 18, ["landing/02-landing-why-not-a-chatbot.png", "landing/07-landing-why-not-a-chatbot-finnish.png"],
  "You could ask a chatbot to interview your team. [pause 0.4s] "
  "But every conversation comes out a little different, and nothing is counted across people. [pause 0.4s] "
  "Here, everyone gets the *same* interview, from a template that is fixed for the campaign."),
 ("S3", 13, ["case1-discovery/01-participant-arrival.png", "case1-discovery/03-participant-details-and-choice.png", "case1-discovery/04-participant-consent.png", "case1-discovery/02-participant-arrival-mobile.png"],
  "A colleague opens a link. No account, no app. [pause 0.4s] They see who is asking, what is kept, and "
  "choose to take part with their name, or anonymously. [pause 0.4s] Then they agree, and start."),
 ("S4", 15, ["case1-discovery/06-interview-chat-mid-conversation.png", "case1-discovery/07-interview-chat-mobile.png", "case1-discovery/06b-interview-answer-options.png"],
  "The interviewer asks one question at a time, about how the work is really done. [pause 0.4s] "
  "It can offer answer options, and it works on a phone. [pause 0.4s] "
  "(slower) It is told never to ask where AI should be used."),
 ("S5", 7, ["case1-discovery/08-interview-end-state.png"],
  "At the end, the person sees their own summary, [pause 0.4s] and can correct it."),
 ("S6", 11, ["case1-discovery/11-campaign-page.png", "case1-discovery/10-analysis-in-progress.png", "case1-discovery/12-results-summary-and-first-opportunity.png"],
  "In this demo, ten simulated colleagues from three departments took part. [pause 0.4s] "
  "Their answers became two hundred and eighty-eight items, grouped into twenty-five themes."),
 ("S7", 12, ["case1-discovery/13-opportunity-list-by-solution-class.png", "case1-discovery/14-opportunity-detail-with-evidence-quotes.png"],
  "Each theme is scored, and classed as AI, automation, software, or process. [pause 0.4s] "
  "Open one, and you see the reasoning, and the quotes behind it."),
 ("S8", 13, ["case1-discovery/15-department-comparison.png", "case1-discovery/18-report-department-comparison-k-rule.png"],
  "Anonymity is a rule, not a promise. [pause 0.4s] A department, a role or a quote appears only when at "
  "least three people are behind it. [pause 0.4s] Below that, it says *withheld*."),
 ("S9", 10, ["case1-discovery/17-report-preview.png", "case1-discovery/23-report-pdf-page-2.png", "case1-discovery/16-where-ai-is-not-the-answer.png"],
  "The report states its method, [pause 0.4s] and what it does not do. It can say that AI is not the answer. [pause 0.4s] Download it as PDF."),
 ("S10", 11, ["case2-requirements/12-bridge-requirement-from-discovery-opportunity.png"],
  "Pick an opportunity, and start a requirements interview from it. [pause 0.4s] "
  "What the first round learned is carried over, so the second interview asks only what is missing."),
 ("S11", 15, ["case2-requirements/02-requirements-workspace.png", "case2-requirements/04-workspace-findings-and-mvp-challenge.png"],
  "Or start from one sentence. A small parking tool, for clinic visitors. [pause 0.4s] "
  "It settles the context, then decides one thing at a time. [pause 0.4s] "
  "At the end it reads the list back, and says what is still open."),
 ("S12", 9, ["case2-requirements/05-specification-version.png", "case2-requirements/06-requirement-detail-acceptance-criteria.png"],
  "Out comes a specification. Numbered requirements, each with acceptance criteria. [pause 0.4s] "
  "Marked MVP, or later."),
 ("S13", 13, ["case2-requirements/11-version-diff.png", "case2-requirements/09-version-downloads-and-compare.png", "case2-requirements/15-specification-pdf-page-2.png"],
  "Reopen the interview, change your mind, and you get a second version, [pause 0.4s] with a diff. "
  "Download it as PDF, as Markdown, or as a bundle for a coding agent."),
 ("S14", 12, ["landing/03-landing-trust.png", "landing/05-landing-hero-dark.png", "case2-requirements/14-requirements-workspace-finnish.png"],
  "It is built to run on a server you operate. [pause 0.4s] Every model call is recorded with its cost. "
  "The interface comes in English and Finnish, in light and dark."),
 ("S15", 9, ["landing/01-landing-hero.png"],
  "(warm) Understand the problem, *then* decide what to build. [beat] "
  "(slower) The colleagues in this demo were simulated, and the figures come from one test run."),
]

SHORT = [
 ("A1", 6, ["landing/01-landing-hero.png"], "(warm) Understand the problem, [pause 0.4s] before deciding what to build."),
 ("A2", 10, ["landing/02-landing-why-not-a-chatbot.png"],
  "A chatbot gives one draft per person. [pause 0.4s] Here, everyone gets the *same* interview, and the answers are counted together."),
 ("A3", 10, ["case1-discovery/06-interview-chat-mid-conversation.png", "case1-discovery/07-interview-chat-mobile.png"],
  "No account, no app. One question at a time, on a phone or in a browser. [pause 0.4s] It never asks where AI should go."),
 ("A4", 10, ["case1-discovery/13-opportunity-list-by-solution-class.png", "case1-discovery/14-opportunity-detail-with-evidence-quotes.png"],
  "Ten simulated colleagues became twenty-five themes, ranked, with the quotes behind each one."),
 ("A5", 8, ["case1-discovery/15-department-comparison.png"],
  "A department or a quote shows only when at least three people are behind it."),
 ("A6", 6, ["case2-requirements/12-bridge-requirement-from-discovery-opportunity.png"],
  "Take an opportunity into a requirements interview."),
 ("A7", 10, ["case2-requirements/06-requirement-detail-acceptance-criteria.png", "case2-requirements/11-version-diff.png"],
  "Out comes a versioned specification: numbered requirements, acceptance criteria, a diff, and a bundle for your coding agent."),
]

CUE = re.compile(r"\[(?:pause [0-9.]+s|beat)\]|\((?:slower|warm|lift)\)")

def plain(t):
    t = CUE.sub("", t).replace("*", "")
    return re.sub(r"\s+", " ", t).strip().replace(" ,", ",").replace(" .", ".")

def ts(s):
    ms = int(round(s * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); sec, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{sec:02},{ms:03}"

def sentences(t):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", plain(t)) if s.strip()]

def srt(scenes):
    out, n, t = [], 1, 0.0
    for sid, dur, _, text in scenes:
        sents = sentences(text)
        # leave 0.3 s of air at the end of each scene
        usable = dur - 0.3
        words = [max(1, len(s.split())) for s in sents]
        total = sum(words)
        cur = t
        for s, w in zip(sents, words):
            d = usable * w / total
            out.append(f"{n}\n{ts(cur)} --> {ts(cur + d - 0.05)}\n{s}\n")
            n += 1
            cur += d
        t += dur
    return "\n".join(out), t

LEGEND = """CUE LEGEND
  [pause 0.4s]  a short breath between phrases (about 400 ms of silence)
  [pause 1s]    a full stop, the picture changes or something lands (1000 ms)
  [beat]        a slightly longer pause than a comma, about 600 ms, used before the last line
  *word*        stress this word
  (slower)      read the next sentence about 15 percent slower
  (warm)        smile in the voice, softer and closer to the microphone
  (lift)        let the pitch rise a little, as at the start of a new idea
Cues are never read out. script-plain.txt is the same text without them.
Screenshot paths are relative to marketing/demo-2026-10/screenshots/.
Durations include the pauses. Pace: about 2.2 spoken words per second.
"""

def render(title, scenes, with_cues=True):
    lines = [title, ""]
    if with_cues:
        lines += [LEGEND]
    t = 0.0
    for sid, dur, shots, text in scenes:
        head = f"[{sid}]  {ts(t)[3:8]}-{ts(t+dur)[3:8]}  ({dur} s)"
        lines.append(head)
        if with_cues:
            lines.append("  shots: " + ", ".join(shots))
        body = text if with_cues else plain(text)
        lines.append("  " + body)
        lines.append("")
        t += dur
    return "\n".join(lines), t

full_txt, tf = render("VOICE-OVER SCRIPT: full cut", FULL)
short_txt, ts_ = render("VOICE-OVER SCRIPT: 60 second cut", SHORT, True)
with open(f"{OUT}/script.txt", "w") as f:
    f.write(full_txt.split("CUE LEGEND")[0])
    f.write(LEGEND + "\n" + "=" * 70 + "\nFULL CUT  (" + f"{tf:.0f} s)\n" + "=" * 70 + "\n\n")
    f.write(render("", FULL, True)[0].replace(LEGEND, "").strip() + "\n\n")
    f.write("=" * 70 + f"\n60 SECOND CUT  ({ts_:.0f} s)\n" + "=" * 70 + "\n\n")
    f.write(render("", SHORT, True)[0].replace(LEGEND, "").strip() + "\n")
with open(f"{OUT}/script-plain.txt", "w") as f:
    f.write(f"FULL CUT ({tf:.0f} s)\n\n")
    f.write(render("", FULL, False)[0].strip() + "\n\n")
    f.write(f"60 SECOND CUT ({ts_:.0f} s)\n\n")
    f.write(render("", SHORT, False)[0].strip() + "\n")
for name, sc in (("script", FULL), ("script-60s", SHORT)):
    body, total = srt(sc)
    open(f"{OUT}/{name}.srt", "w").write(body)
    print(name, f"{total:.0f}s")
for sid, dur, _, text in FULL + SHORT:
    w = len(plain(text).split())
    print(sid, dur, w, f"{w/dur:.2f} w/s")
