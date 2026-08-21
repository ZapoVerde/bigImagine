# Architectural Diagnosis

> Optional artifact. Use when the problem is a bug, failure, regression, or poorly understood behaviour. Do not use this phase merely because a feature is technically complicated.

## 1. Problem Summary

State the observed problem in one precise sentence.

## 2. Evidence

Record the concrete evidence available before proposing a solution:

- observed behaviour
- expected behaviour
- error messages or logs
- reproducibility information
- affected user/system path
- known recent changes, if relevant

## 3. Analysis Across Three Axes

### 3.1 Implementation Axis — What is broken?

Identify the immediate technical cause as far as the available evidence supports it.

Include:

- responsible logic or control path
- incorrect state/data transition
- failing interface or assumption
- relevant runtime/build/test evidence

Do not propose the architectural solution here.

### 3.2 Architectural Axis — How did this happen?

Explain how the implementation failure relates to the local architecture.

Identify:

- ownership boundaries
- violated local contracts
- duplicated or bypassed responsibilities
- incorrect coupling
- stale assumptions between components

Determine whether the failure is isolated or indicates a systemic design problem.

### 3.3 Principle Axis — Why does this matter?

Connect the failure to the project's governing principles and intended behaviour.

State the practical consequence of leaving the architectural cause unresolved.

## 4. Confirmed Cause vs Uncertainty

### Confirmed
List conclusions directly supported by repository/runtime evidence.

### Uncertain
List material assumptions that remain unresolved.

## 5. Scope Boundary

State what this diagnosis does **not** establish.

A diagnosis is complete when the problem is sufficiently understood to begin architectural design. It is not an implementation plan.
