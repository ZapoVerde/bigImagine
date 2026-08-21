# Architectural Report

> Purpose: capture the agreed design intent before file-level implementation analysis begins.
>
> This artifact describes behaviour and architecture. It must remain implementation-agnostic: do not name source files or prescribe line-level code changes.

## 1. High-Level Goal & Rationale

Describe the primary objective and why the change is required.

## 1.1 Detailed Description

Describe the desired system behaviour comprehensively enough that a separate systems analyst can inspect the repository and determine how the existing implementation must change.

Include important current behaviour where needed to establish contrast with the desired behaviour.

## 2. Core Principles & Constraints

### 2.1 Governing Project Principles

List existing project-level principles, architecture rules, domain boundaries, or established conventions that govern this change.

Only include principles relevant to this work.

### 2.2 Change-Specific Principles

List the non-negotiable rules established for this change.

These are behavioural/architectural guardrails, not implementation instructions.

### 2.3 Explicit Non-Goals

State what is intentionally outside the scope of this change.

## 3. Architectural Flows

Include only flows relevant to the change, but when a flow is included it must be complete.

### 3.1 User Flow

Describe the user-visible journey step by step.

If the change has no meaningful user flow, state `Not applicable`.

### 3.2 Data Flow

Describe how relevant information enters, moves through, is transformed by, and leaves the system.

Include persistence boundaries where relevant.

### 3.3 Logic Flow

Describe the decisions, gates, state transitions, fallbacks, retries, and terminal outcomes that define the required behaviour.

### 3.4 Failure Flow

Describe expected behaviour when dependencies, validation, persistence, network operations, or other relevant operations fail.

If failure behaviour is unchanged and irrelevant, state that explicitly.

## 4. Overall Acceptance Criteria

List explicit, externally meaningful outcomes defining completion.

Each criterion must be:

- unambiguous
- observable or verifiable
- about the completed behaviour rather than a particular implementation

Use stable IDs:

- `AC-01`
- `AC-02`
- `AC-03`

Example:

- **AC-01:** Repeating the same operation with unchanged qualifying inputs reuses the existing result rather than creating a new one.

## 5. Open Architectural Questions

List unresolved questions that materially affect architecture.

This section must be empty before the artifact is considered final.
