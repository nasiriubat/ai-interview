# Intake v2: expanded description as received

> Captured verbatim on 2026-09-08 after round 2. Supersedes nothing; it extends
> `00-intake.md`. The gap analysis in `04-gap-analysis-intake-v2.md` lists what it
> changes in the spec.

## AI Powered Discovery and Requirements Engineering Platform

The proposed system is an AI powered interview and discovery platform designed to help organizations identify valuable AI and automation opportunities and transform ideas into clear, implementation ready product specifications.

The system will initially provide two connected workflows.

### 1. AI and Automation Opportunity Discovery

Organizations can create an assessment campaign and share a unique interview link with their employees. The administrator can decide whether participants provide personal information such as name, role and department, or participate anonymously.

Instead of using a fixed questionnaire, the system conducts an adaptive AI interview. It first understands the employee's role and responsibilities, then explores their daily activities, repetitive tasks, tools, manual processes, information flows, bottlenecks and common problems.

The AI dynamically asks follow up questions when an answer is unclear or when additional information could reveal an important process or problem. The goal is to understand how work is actually performed rather than simply asking employees where they think AI should be used.

Once enough employees complete the interview, the system analyzes the responses collectively. Similar activities and problems are grouped together and potential improvement opportunities are identified.

The resulting organization level report highlights areas suitable for AI, traditional automation, software development or process improvement. Opportunities can be evaluated based on factors such as expected impact, affected employees, frequency of the problem, implementation complexity, data availability, risk and AI suitability.

The system should also be capable of concluding that AI is not appropriate for a particular problem. The purpose is to identify useful solutions rather than force AI into every process.

### 2. Product Requirements Discovery

The second workflow helps technical and nontechnical users transform a rough product idea into a well defined product specification.

A user can begin with something as simple as a short description of an idea. The AI then conducts an interactive requirements interview to understand the problem, target users, expected functionality, workflows, business rules, constraints, integrations, security requirements, data requirements, technical preferences and edge cases.

Questions should adapt to the user's knowledge. A technical user may specify architecture, APIs, databases or preferred technologies. A nontechnical user can describe the expected behavior in normal language, allowing the system to derive or recommend appropriate technical requirements.

The AI should actively detect unclear requirements, contradictions, missing decisions and unnecessary complexity. It should also help separate essential MVP functionality from future features so that users do not overengineer the first version.

At the end of the interview, the system generates a structured and reviewable product specification. Outputs may include the product requirements, functional requirements, user roles, user stories, business rules, acceptance criteria, technical requirements, data requirements, integrations, nonfunctional requirements, MVP scope, future scope and implementation phases.

The final specification can be exported as a human readable document or as structured Markdown designed for coding agents such as Codex or Claude Code.

### Connecting the Two Workflows

The two workflows can operate independently or as a connected pipeline.

For example, an organization may first interview its employees and discover that internal knowledge retrieval is a high value AI opportunity. An administrator can select that opportunity and start the Product Requirements Discovery workflow directly from it.

The second workflow will inherit the information already discovered, including the business problem, affected users, existing processes, tools, constraints and expected benefits. The AI then asks only the additional questions required to transform the opportunity into an implementation ready solution.

The complete workflow can therefore become:

**Employee Interviews → Work Process Analysis → AI and Automation Opportunities → Opportunity Selection → Requirements Interview → Product Specification → Implementation Plan → Developer or Coding Agent**

### Platform Administration

The system should be designed around configurable interview templates rather than hardcoded questionnaires. Administrators can create different interview types, define their objectives, configure privacy settings, customize questions and AI instructions, determine expected outputs and optionally connect one interview workflow to another.

This allows the initial two workflows to later expand into other discovery processes without rebuilding the core platform.

The central principle of the system is simple: **understand the problem thoroughly before deciding what to build.** The platform should use AI not merely to generate documents, but to conduct structured discovery, challenge assumptions, uncover missing information and convert scattered human knowledge into actionable implementation plans.
