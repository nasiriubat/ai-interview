# 00 Overview

## Product

An AI-powered interview and discovery platform. It helps organizations identify
valuable AI and automation opportunities by interviewing employees about how work is
actually done, and it turns rough ideas or discovered opportunities into clear,
implementation-ready product specifications through an adaptive requirements interview.

## Principle

**Understand the problem thoroughly before deciding what to build.** The AI conducts
structured discovery, challenges assumptions, uncovers missing information, and is
allowed to conclude that AI is the wrong answer.

## Users

| Persona | Goal |
|---|---|
| Participant (employee) | Describe how their work is actually done, identified or anonymous, by chat, options, voice, or documents; feel like they are talking to a capable assistant |
| Company admin | Run campaigns from templates, read the organization report, select opportunities, manage templates, providers, budgets, privacy; see stats and change behavior without code |
| Idea owner (technical or nontechnical) | Turn an idea or an opportunity into a reviewable specification and implementation plan |
| External requirements user | Same as idea owner, invited by a company admin through a link (consultancy clients) |
| Developer or coding agent | Receive a specification and phase plan with no missing decisions |
| Platform operator | Tenants, platform providers, routing defaults, seeded templates, global stats |

## Core concepts

- **Interview template**: data that defines an interview type. See `01`.
- **Campaign**: a run of a template with a participation mode and links. See `06`.
- **Session**: one interview: consent, state, summary, messages, events, attachments.
- **Turn object**: what the interviewer returns each turn: message, optional widget, voice hint, state delta. See `02`.
- **Facts**: structured outputs extracted from a session continuously.
- **Analysis**: collective processing across a campaign's sessions. See `04`.
- **Opportunity**: an analysis result with a solution class and seven scored factors.
- **Specification**: the versioned output of a requirements session. See `05`.
- **Hand-off**: the typed object carried from one template to the next.
- **Purpose**: the reason for a model call; every call has one, and routing and budgets are per purpose. See `08`.

## The pipeline

Employee interviews → work process analysis → AI and automation opportunities →
opportunity selection → requirements interview → product specification → implementation
plan → developer or coding agent. Each step also works alone.
