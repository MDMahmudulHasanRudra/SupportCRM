# SUPPORT CRM
## Canonical Product, Architecture & Implementation Specification

> Version: 1.0
> Status: Master Specification
> Project Type: Production-grade WhatsApp-first Support CRM
> Primary Channel: WhatsApp
> Future Channels: Facebook, Messenger, Facebook Pages, other messaging channels
> Primary Integration Foundation: OpenWA
> Primary Database: PostgreSQL
> Cache / Queue: Redis
> Deployment: Docker
> Architecture: Modular Monolith
>
> IMPORTANT:
> This document is the canonical source of truth for the Support CRM project.
> All implementation decisions must follow this specification unless a later
> explicit architectural decision supersedes it.

---

# 1. ROLE OF THE CODING AGENT

You are acting as:

- Principal Software Architect
- Senior Backend Engineer
- Senior Frontend Engineer
- Database Architect
- AI Systems Engineer
- DevOps Engineer
- Security Engineer
- QA Engineer
- Product Engineer

Your responsibility is to build a real production-grade application.

This is NOT a prototype.

This is NOT a static UI demo.

This is NOT a simple WhatsApp bot.

This is a complete:

> WhatsApp-first Support CRM + Knowledge Base + Automation Engine +
> AI Support Agent + Human Escalation + Support Analytics Platform.

The final system must be:

- reliable
- maintainable
- modular
- scalable
- secure
- observable
- testable
- Dockerized
- easy to deploy
- easy to recover
- easy for administrators to configure

---

# 2. ABSOLUTE IMPLEMENTATION RULE

Before implementing major functionality:

1. Inspect the existing repository.
2. Understand the existing architecture.
3. Understand OpenWA's current capabilities.
4. Identify reusable modules.
5. Identify integration points.
6. Identify conflicts.
7. Produce an architecture audit.
8. Produce a database/domain plan.
9. Produce an implementation plan.
10. Only then start implementation.

Do NOT blindly rewrite OpenWA.

Do NOT replace working OpenWA components without reason.

Do NOT create duplicate WhatsApp functionality if OpenWA already provides it.

Do NOT make destructive changes during the initial audit.

---

# 3. OPENWA REPOSITORY

The project is based on:

https://github.com/rmyndharis/OpenWA

The agent MUST inspect the actual repository available in the working environment.

Do not rely only on assumptions from this specification.

Audit:

- repository structure
- backend
- frontend
- NestJS modules
- TypeScript configuration
- database
- TypeORM
- migrations
- Redis
- queues
- WhatsApp engine
- sessions
- authentication
- authorization
- contacts
- groups
- messages
- webhooks
- events
- plugins
- dashboard
- APIs
- OpenAPI
- MCP
- Docker
- environment configuration
- tests
- rate limiting
- error handling
- logging
- storage

Determine:

### Reuse

What can be used directly.

### Extend

What should be extended.

### Isolate

What should be implemented as Support CRM modules.

### Replace

Only replace an existing implementation when there is a strong architectural reason.

---

# 4. PRODUCT VISION

Support CRM exists to reduce repetitive human support workload.

The business currently provides software/ISP support through WhatsApp groups.

Customers ask:

- software questions
- module questions
- billing questions
- configuration questions
- troubleshooting questions
- MikroTik questions
- networking questions
- installation questions
- usage questions

Many questions are repetitive.

Example:

Customer:

> "MikroTik unreachable"

Support team repeatedly sends:

- troubleshooting instructions
- documentation
- YouTube video
- configuration steps

Support CRM should automate these repetitive interactions.

The system must intelligently combine:

1. Deterministic automation
2. Knowledge Base
3. AI
4. Human support

The fundamental philosophy is:

> Automation handles repetition.
>
> AI handles conversation.
>
> Humans handle uncertainty and exceptions.

---

# 5. CORE MESSAGE ROUTING PRINCIPLE

This is the most important architectural rule in the entire project.

AI must NOT reply to every incoming message.

The system uses:

> Automation First → Knowledge → AI → Human

But the actual decision is controlled by a centralized:

# Message Decision Engine

No module should independently decide whether it is allowed to reply.

Every incoming message passes through the centralized decision pipeline.

---

# 6. MESSAGE DECISION PIPELINE

Conceptual flow:

Incoming Message
        |
        v
Message Validation
        |
        v
Idempotency
        |
        v
Conversation State
        |
        v
Safety / Policy
        |
        v
Deterministic Automation
        |
        v
Knowledge / Intent Detection
        |
        v
AI Decision Engine
        |
        v
Human Escalation
        |
        v
Outgoing Message Queue
        |
        v
Channel Adapter
        |
        v
WhatsApp / OpenWA

Heavy operations MUST NOT execute synchronously inside the webhook request.

---

# 7. CONVERSATION STATE MACHINE

Every conversation must have an explicit state.

Supported states:

- AUTOMATION_ACTIVE
- AI_ACTIVE
- HUMAN_ACTIVE
- HUMAN_REQUIRED
- PAUSED
- WAITING_CUSTOMER
- RESOLVED

The state determines which engines are allowed to act.

---

# 8. STATE RULES

## AUTOMATION_ACTIVE

Deterministic automation may respond.

AI may only respond if the automation policy explicitly allows it.

---

## AI_ACTIVE

AI may respond if:

- AI is enabled
- policy allows
- relevant knowledge exists or AI can safely answer
- confidence is sufficient
- no human takeover exists

---

## HUMAN_ACTIVE

AI must NOT automatically respond.

Automation behavior must follow configured policy.

Human owns the conversation.

---

## HUMAN_REQUIRED

AI must stop responding.

The system waits for human intervention.

---

## PAUSED

Automated outgoing communication is disabled.

---

## WAITING_CUSTOMER

System has sent a response and is waiting for customer response.

---

## RESOLVED

Conversation is closed.

New incoming customer message may reopen the conversation depending on configuration.

---

# 9. ROUTING EXAMPLE

Customer:

> Hello

System checks:

1. Group active?
2. Monitoring enabled?
3. Conversation state?
4. Automation rules?
5. Knowledge?
6. AI enabled?
7. Policy?

If an exact greeting automation exists:

Send predefined greeting.

AI is NOT called.

---

# 10. SECOND EXAMPLE

Customer:

> Software slow হচ্ছে

Automation:

"software slow"

matches.

System sends:

- predefined explanation
- troubleshooting steps
- documentation
- video

AI is NOT called.

---

# 11. THIRD EXAMPLE

Customer:

> Software slow হচ্ছে, সব troubleshooting করেছি।
> Database server নিয়েও সমস্যা মনে হচ্ছে।

No deterministic automation matches the new context.

System:

Automation
    ↓
No suitable match
    ↓
Knowledge retrieval
    ↓
AI

AI receives:

- recent conversation
- conversation summary
- relevant knowledge
- support profile
- group context
- customer context
- AI policy

AI decides whether it can safely respond.

---

# 12. FOURTH EXAMPLE

Customer:

> MikroTik unreachable

Automation sends troubleshooting instructions.

Customer:

> সব করেছি, তবুও কাজ হচ্ছে না। আমার ক্ষেত্রে অন্য একটা সমস্যা হচ্ছে।

Existing automation no longer handles the conversation.

AI receives:

- original customer message
- automation response
- customer reply
- recent history
- relevant knowledge

AI may continue the conversation.

If AI cannot safely resolve:

Escalate to human.

---

# 13. AUTOMATION FIRST

Deterministic automation should always be evaluated before expensive AI inference whenever practical.

Examples:

- hello
- hi
- হাই
- হ্যালো
- software slow
- MikroTik unreachable
- invoice কোথায়
- report কোথায়
- module কীভাবে open করব
- installation guide
- troubleshooting request with known procedure

Automation reduces:

- AI cost
- AI latency
- unnecessary model calls
- hallucination risk

---

# 14. KNOWLEDGE MATCH

If deterministic automation does not match:

Evaluate the Knowledge Base.

Search methods may include:

- exact keyword
- full-text search
- semantic search
- vector search
- intent classification

Knowledge retrieval should be selective.

Never send the entire Knowledge Base to the AI.

---

# 15. KNOWLEDGE-DRIVEN RESPONSE

A knowledge match does NOT automatically require AI.

The system may:

1. Send a predefined knowledge response.
2. Send a template.
3. Send documentation.
4. Send a video.
5. Give AI the knowledge and let AI generate a contextual answer.

The policy determines which behavior is appropriate.

---

# 16. AI DECISION ENGINE

If automation cannot safely resolve the issue and AI is enabled:

Invoke AI.

The AI must return structured decision data.

Conceptual response:

{
  "intent": "mikrotik_connectivity",
  "answer": "...",
  "confidence": 0.91,
  "knowledgeUsed": true,
  "knowledgeSources": [
    "KB-102",
    "KB-115"
  ],
  "needsHuman": false,
  "reason": "...",
  "suggestedAction": "reply"
}

Implementation format may differ, but the decision MUST be machine-readable.

---

# 17. AI CONFIDENCE

Do NOT treat model confidence as absolute truth.

Decision must consider:

- AI confidence
- knowledge relevance
- knowledge availability
- policy
- conversation context
- intent certainty
- previous attempts
- customer request for human
- sensitive operation detection
- repetition/loop detection

---

# 18. CONFIDENCE POLICY

Admin-configurable example:

AI reply threshold:

0.80

AI clarification threshold:

0.60

Below:

Human escalation.

These values MUST NOT be hardcoded.

Support Profile and Group may override global thresholds.

---

# 19. AI CONFIDENCE RULE

HIGH CONFIDENCE
+
SUFFICIENT KNOWLEDGE
+
POLICY ALLOWS

→ AI Reply

MEDIUM CONFIDENCE

→ Clarify OR Escalate

LOW CONFIDENCE

→ Human Escalation

---

# 20. IMPORTANT AI SAFETY RULE

Even if AI confidence is high, it must not perform restricted actions without explicit policy.

Examples:

- changing production network configuration
- deleting customer data
- changing billing
- refunds
- account ownership changes
- security-sensitive operations
- destructive commands

Such actions require human approval or explicit safe automation.

---

# 21. AI PROVIDER ABSTRACTION

Create:

AIProvider

Capabilities:

- chat
- embeddings
- classification
- summarization
- structured output

Potential providers:

- OpenAI
- Gemini
- Anthropic
- OpenRouter
- OpenAI-compatible APIs
- custom endpoint
- future local models

Do NOT hardcode one provider.

---

# 22. AI CONFIGURATION

Admin can configure:

- provider
- model
- API key
- base URL
- temperature
- max tokens
- language
- tone
- response length
- confidence threshold
- maximum AI replies
- memory policy
- knowledge policy
- escalation policy

Secrets must be protected.

---

# 23. AI PERSONALITY

Configurable:

- professional
- friendly
- technical
- concise
- detailed
- Bangla
- English
- Bangla + English
- emoji level

Example:

Professional
Bangla + English
Short
Minimal emoji
Intermediate technical level

---

# 24. AI SYSTEM INSTRUCTIONS

Admin can define global system instructions.

Example:

"You are the technical support assistant for IC Billing Software.

Only use approved knowledge when providing technical instructions.

Never invent procedures.

If information is unavailable or uncertain, escalate to human support."

Support:

Global instructions
Support Profile instructions
Group-specific instructions

More specific instructions override broader instructions where appropriate.

---

# 25. AI MEMORY

Use three levels.

## Short-term

Recent conversation messages.

## Medium-term

Recent support history and conversation summary.

## Long-term

Approved customer facts and historical issue summaries.

Do NOT send the entire message history to every AI request.

---

# 26. CONVERSATION SUMMARIZATION

For long conversations, maintain a summary containing:

- issue
- attempted solutions
- current state
- unresolved issue
- important customer information
- human decisions
- relevant knowledge
- escalation status

Use summary + recent messages.

---

# 27. AI RESPONSE AUDIT

Store:

- AI request ID
- provider
- model
- conversation
- relevant knowledge IDs
- confidence
- decision
- escalation
- outcome

Do not expose secrets.

Do not store unnecessary sensitive prompt data.

---

# 28. HUMAN ESCALATION

AI must escalate when:

- confidence is low
- knowledge is missing
- customer explicitly asks for human
- customer repeatedly says problem is unresolved
- AI cannot understand the issue
- AI detects unsupported technical issue
- sensitive decision is required
- AI reaches maximum reply count
- conversation loop is detected
- provider failure prevents reliable response

---

# 29. ESCALATION FLOW

When escalation occurs:

1. Create escalation record.
2. Change conversation state to HUMAN_REQUIRED.
3. Stop AI replies.
4. Stop conflicting automation.
5. Notify internal support group.
6. Notify configured executives.
7. Create dashboard notification.
8. Record reason.
9. Preserve conversation context.
10. Wait for human takeover.

---

# 30. ESCALATION CONFIGURATION

Admin can configure:

- internal escalation group
- primary executives
- secondary executives
- escalation priority
- notify internal group
- notify executives
- customer notification
- maximum AI attempts
- maximum AI replies
- confidence threshold

Configuration hierarchy:

Global
↓
Support Profile
↓
Group
↓
Conversation

---

# 31. ESCALATION MESSAGE

Example internal notification:

🚨 HUMAN SUPPORT REQUIRED

Group:
ABC ISP Support

Customer:
ABC Customer

Issue:
MikroTik connectivity

Reason:
AI could not confidently resolve the issue.

Priority:
HIGH

Conversation:
[Open Conversation]

---

# 32. CUSTOMER ESCALATION MESSAGE

Admin can configure whether customer receives an automatic message.

Example:

"আপনার সমস্যাটি আমাদের support team-এর কাছে পাঠানো হয়েছে। একজন support executive খুব শীঘ্রই আপনার সাথে যোগাযোগ করবেন।"

This behavior must be configurable.

---

# 33. INDIVIDUAL EXECUTIVE NOTIFICATION

Admin may configure:

Primary:
Executive A
Executive B

Secondary:
Executive C

System can privately notify them.

---

# 34. INTERNAL GROUP NOTIFICATION

Every Support Profile or Group may have an internal escalation group.

Example:

Customer Group:
ABC ISP Support

Internal Group:
ABC Support Internal

When escalation happens:

AI → Internal Group

---

# 35. HUMAN TAKEOVER

Support executive clicks:

TAKE OVER

Conversation becomes:

HUMAN_ACTIVE

AI immediately stops.

UI clearly displays:

👨‍💻 HUMAN ACTIVE

---

# 36. RELEASE TO AI

Human may click:

RELEASE TO AI

Conversation becomes:

AI_ACTIVE

AI resumes according to policy.

---

# 37. AI KILL SWITCH

Global controls:

- Pause All AI
- Pause All Automation
- Stop Automated Outgoing Messages
- Disable Broadcast
- Pause Bulk Operations

Require confirmation.

Audit every action.

---

# 38. CONVERSATION-LEVEL AI CONTROL

Conversation controls:

- AI ON
- AI OFF
- PAUSE
- HUMAN TAKEOVER
- RELEASE TO AI
- ESCALATE
- RESOLVE

---

# 39. HUMAN REQUEST DETECTION

Detect messages such as:

"human চাই"

"একজন support agent দেন"

"মানুষের সাথে কথা বলতে চাই"

"ভাই একজন মানুষ দেন"

Depending on policy:

Immediate human escalation.

AI must not argue with the customer.

---

# 40. AI LOOP PROTECTION

Prevent:

Customer
→ AI
→ Customer
→ AI
→ Customer
→ AI

Implement:

- maximum AI replies
- maximum consecutive AI replies
- cooldown
- duplicate response detection
- similar response detection
- conversation timeout
- escalation after threshold

---

# 41. REPETITION DETECTION

Detect:

- same question repeated
- same automation repeatedly triggered
- customer repeatedly rejecting answer
- AI repeating similar response

Increase escalation score.

If threshold reached:

Escalate or pause.

---

# 42. SUPPORT PROFILES

Create reusable Support Profiles.

Example:

Standard ISP Support

Configuration:

- AI mode
- automation profile
- knowledge profile
- escalation policy
- business hours
- response style
- language
- AI personality
- max AI replies
- confidence threshold
- cooldown
- rate limits
- assigned support team

---

# 43. GROUP MODES

Supported modes:

MANUAL
AUTOMATION_FIRST
AI_FIRST
HYBRID
HUMAN_ONLY
PAUSED

Recommended default:

HYBRID

---

# 44. GROUP CONFIGURATION

Each group can have:

- WhatsApp ID
- name
- description
- customer
- support profile
- AI mode
- automation profile
- knowledge profile
- monitoring
- escalation
- assigned executives
- tags
- status
- last activity

---

# 45. PROFILE INHERITANCE

Hierarchy:

Global
↓
Support Profile
↓
Group
↓
Conversation

Specific overrides general.

---

# 46. GROUP MONITORING

Each group:

MONITORED
UNMONITORED
PAUSED

Monitoring determines whether messages participate in:

- automation
- AI
- support activities
- escalation

---

# 47. BULK GROUP OPERATIONS

System must support 3,000+ groups.

Bulk actions:

- enable AI
- disable AI
- enable monitoring
- disable monitoring
- enable automation
- disable automation
- assign profile
- assign knowledge profile
- assign support team
- change AI mode
- pause AI
- resume AI
- add tag
- remove tag
- archive
- export
- configure escalation

---

# 48. BULK FILTERS

Filter groups by:

- support profile
- AI mode
- monitoring
- customer
- tag
- team
- last activity
- creation date
- unresolved conversations
- AI escalation count

Bulk operations work on filtered selection.

---

# 49. BULK OPERATIONS MUST BE ASYNC

Never process thousands of records synchronously.

Use:

Job
↓
Queue
↓
Worker
↓
Batch processing
↓
Progress
↓
Retry
↓
Result

---

# 50. JOB CENTER

Central Job Center.

Example:

Bulk Enable AI

Groups:
500

Completed:
482

Failed:
18

Progress:
96.4%

Actions:

- View errors
- Retry failed
- Cancel if possible
- View logs

---

# 51. JOB TYPES

- bulk group update
- broadcast
- member addition
- member removal
- knowledge indexing
- AI processing
- automation analysis
- report generation
- export
- media processing

---

# 52. WHATSAPP CONNECTION

Use OpenWA as the WhatsApp integration foundation.

Admin can:

- create session
- scan QR
- connect
- disconnect
- reconnect
- view health
- view account
- manage sessions

Status:

CONNECTED
CONNECTING
DISCONNECTED
ERROR

---

# 53. CHANNEL ABSTRACTION

Do not tightly couple business logic to WhatsApp.

Create abstraction:

Channel
ChannelAccount
ChannelContact
ChannelGroup
ChannelConversation
ChannelMessage
ChannelMember
ChannelAdapter

WhatsApp implements the channel adapter.

Future:

Facebook
Messenger
Facebook Pages
Other channels

---

# 54. WHATSAPP ADAPTER

The WhatsApp adapter communicates with OpenWA.

Business modules must NOT directly call OpenWA.

Only the channel/integration layer may communicate with OpenWA.

---

# 55. INCOMING MESSAGE PIPELINE

WhatsApp/OpenWA
↓
Webhook/Event
↓
Validation
↓
Idempotency
↓
Persist Message
↓
Queue
↓
Decision Engine
↓
Automation/Knowledge/AI
↓
Human escalation if required
↓
Outgoing Queue
↓
OpenWA

---

# 56. OUTGOING MESSAGE QUEUE

Every automated/AI/broadcast message should pass through a centralized outgoing queue.

Metadata:

- priority
- conversation
- group
- message
- source
- automation ID
- AI request ID
- broadcast ID
- retry count
- scheduled time

---

# 57. RATE LIMITING

Rate limits:

- per WhatsApp session
- per group
- per destination
- broadcast
- automation
- AI
- API

All configurable.

---

# 58. RETRY

Transient failures:

Attempt 1
↓
backoff
↓
Attempt 2
↓
backoff
↓
Attempt 3
↓
failed

Failed jobs can be retried from Job Center.

Use exponential backoff where appropriate.

---

# 59. IDEMPOTENCY

WhatsApp events may be duplicated.

Use:

channel + external message ID

or equivalent unique identifier.

Duplicate messages must not create duplicate database records or duplicate automated replies.

---

# 60. SUPPORT INBOX

Create a full CRM inbox.

Layout:

Left:
Conversation list

Center:
Conversation

Right:
Context

Filters:

- all
- unread
- open
- assigned
- AI
- human
- escalated
- pinned
- resolved
- waiting

Search:

- customer
- group
- phone
- message
- tag

---

# 61. CONVERSATION ACTIONS

- reply
- attach
- image
- video
- document
- link
- pin
- assign
- tag
- internal note
- take over
- release to AI
- pause AI
- resume AI
- escalate
- resolve
- reopen

---

# 62. PINNED CONVERSATIONS

CRM-level pinning.

Do not depend solely on WhatsApp pin functionality.

---

# 63. TAGGING

Tags can apply to:

- customer
- group
- conversation

Examples:

VIP
Billing
MikroTik
Urgent
Escalated
AI
Human
Resolved

Support bulk tagging.

---

# 64. CUSTOMER ENTITY

Customer:

- name
- company
- phone
- contacts
- groups
- tags
- notes
- support history
- custom fields
- status

Customer may belong to multiple groups.

---

# 65. CONVERSATION ENTITY

Conversation:

- channel
- group/direct
- customer
- participants
- assigned team
- status
- mode
- AI state
- last message
- unread count
- tags
- priority
- escalation
- timestamps

---

# 66. MESSAGE ENTITY

Message:

- channel
- external ID
- conversation
- sender
- recipient
- type
- text
- media metadata
- timestamp
- direction
- fromMe
- status
- automation relation
- AI relation
- support activity relation

---

# 67. SUPPORT TEAM MEMBERS

Admin can add:

- name
- phone
- WhatsApp ID
- role
- team
- status
- availability
- permissions
- assigned groups
- escalation priority

---

# 68. SUPPORT ACTIVITY TRACKING

If registered support executive sends a message in monitored group:

Create Support Activity.

Track:

- executive
- group
- customer
- conversation
- message
- timestamp
- activity type
- AI-assisted
- automation-assisted
- response time
- resolution relation

---

# 69. TEAM PERFORMANCE

Do NOT judge employees only by message count.

Metrics:

- conversations handled
- groups supported
- unique customers
- resolved
- escalated
- first response time
- average resolution time
- AI-assisted
- automation-assisted
- human-only
- active days

---

# 70. KNOWLEDGE BASE

Knowledge Base is a core system.

Support:

- articles
- PDF
- TXT
- DOCX
- Markdown
- links
- YouTube references
- images where appropriate
- troubleshooting procedures

---

# 71. KNOWLEDGE CATEGORIES

Default:

- Software
- Billing
- MikroTik
- Networking
- Users
- Reports
- Inventory
- Installation
- Troubleshooting
- General

Allow custom categories.

---

# 72. KNOWLEDGE DOCUMENT PROCESSING

Documents should be:

1. uploaded
2. parsed
3. cleaned
4. chunked
5. tagged
6. embedded where appropriate
7. indexed
8. published

Store:

- document
- chunk
- metadata
- category
- tags
- embedding
- source
- version
- created_by
- updated_by

---

# 73. KNOWLEDGE VERSIONING

Support:

Draft
Published
Archived

Versions:

v1
v2
v3

Actions:

- publish
- rollback
- compare
- archive

---

# 74. KNOWLEDGE PRIORITY

Retrieval priority:

Group-specific
↓
Customer-specific
↓
Product-specific
↓
Global

Configurable.

---

# 75. KNOWLEDGE GAP DETECTION

If AI repeatedly escalates due to missing information:

Create:

Knowledge Candidate

Example:

"Customers frequently ask about X, but no approved knowledge exists."

Admin can convert candidate into knowledge.

---

# 76. MANUAL AUTOMATION ENGINE

Create configurable rule engine.

Example:

WHEN:

message received

IF:

message contains "mikrotik"

AND:

group = ABC

AND:

time between 09:00 and 18:00

THEN:

send troubleshooting guide

WAIT:

10 minutes

IF:

customer replies

THEN:

notify support executive

---

# 77. AUTOMATION CONDITIONS

Support:

- exact text
- contains
- starts with
- ends with
- keyword
- regex
- sender
- group
- customer
- tag
- status
- time
- day
- business hours
- attachment type
- message type
- previous message
- AI intent
- AI confidence
- customer history
- profile

---

# 78. AUTOMATION ACTIONS

- send text
- send template
- send image
- send video
- send document
- add tag
- remove tag
- assign executive
- notify internal group
- notify executive
- pause AI
- resume AI
- escalate
- resolve
- change status
- internal note
- create task

---

# 79. AUTOMATION PRIORITY

Rules have priorities.

Example:

Priority 1
Priority 2
Priority 3

Support:

Stop processing after match.

---

# 80. AUTOMATION SCHEDULE

Support:

- start time
- end time
- weekdays
- weekends
- holidays
- business hours
- custom schedules
- timezone

Example:

09:00–18:00:

Normal automation.

18:00–09:00:

After-hours policy.

---

# 81. AUTOMATION COOLDOWN

Prevent repeated responses.

Example:

Same rule cannot trigger again within 10 minutes.

Also use duplicate-message protection.

---

# 82. AUTOMATION VERSIONING

States:

Draft
Published
Paused
Archived

Versions:

v1
v2
v3

Allow rollback.

---

# 83. AUTOMATION SIMULATOR

Admin enters:

"Mikrotik connect হচ্ছে না"

System shows:

Matched rule
Conditions
Knowledge
Actions
Final response

Do not publish from simulator automatically.

---

# 84. AUTOMATION HEALTH

Track:

- trigger count
- success
- failure
- human takeover
- customer follow-up
- resolution
- negative feedback

Calculate health score.

Example:

Automation Health: 94/100

---

# 85. AI AUTOMATION CANDIDATES

AI analyzes historical conversations.

Example:

137 conversations:
MikroTik unreachable

128 resolved with same procedure.

System suggests:

Automation Candidate

Intent:
MikroTik unreachable

Suggested response:
...

Confidence:
94%

Admin:

Approve
Edit
Reject

---

# 86. AUTO-ACTIVATION

Default:

AI must NOT automatically publish production automation.

Optional advanced setting:

High-confidence auto-activation

Default:

OFF

---

# 87. AI LEARNING PIPELINE

Never automatically train production behavior from raw conversations.

Instead:

Conversation
↓
Analytics
↓
Pattern Detection
↓
Candidate
↓
Human Review
↓
Approval
↓
Knowledge / Automation
↓
Production

---

# 88. HUMAN FEEDBACK

Executives can mark AI response:

- Correct
- Wrong
- Edit
- Escalate

If human edits:

Create learning candidate.

Do NOT automatically modify production knowledge.

---

# 89. AI ADMIN COPILOT

Admin can interact with an internal AI assistant.

Examples:

"Show today's support activities."

"How many AI escalations today?"

"What are the top support issues this month?"

"Show unresolved conversations."

"Create a draft automation for MikroTik unreachable."

"Which automations need review?"

"Which groups have AI disabled?"

---

# 90. AI COMMAND SAFETY

Read operations:

May execute automatically if permitted.

Write/destructive operations:

Require confirmation.

Example:

Admin:

"Disable AI for 500 groups."

AI:

"This will disable AI for 500 groups. Confirm?"

Only after confirmation execute.

Never bypass RBAC.

---

# 91. AI KNOWLEDGE ASSISTANT

Admin can say:

"Add this PDF to the knowledge base."

"Create article from this text."

"Associate this YouTube video with MikroTik troubleshooting."

"Put this document into Billing."

AI prepares draft.

Human approves.

---

# 92. AI GATEWAY API

Provide secure API:

POST /api/v1/ai/chat

Input:

- message
- conversation
- group
- customer
- channel

System:

- policy
- retrieval
- AI
- decision

Return:

structured result.

---

# 93. EXTERNAL AI INTEGRATION

Support secure external clients.

Potential:

- REST
- OpenAI-compatible interface
- MCP
- Webhooks

Use scoped API keys.

---

# 94. BROADCAST

Broadcast to:

- groups
- customers
- contacts
- tags
- profiles
- filtered audience

Message types:

- text
- image
- video
- document

Support:

- preview
- test send
- immediate
- scheduled
- cancel

---

# 95. BROADCAST SAFETY

Never send thousands simultaneously.

Use:

- queue
- batching
- rate limiting
- retry
- failure tracking

Track:

queued
sent
delivered if available
failed
skipped

---

# 96. GROUP MEMBER MANAGEMENT

Using capabilities supported by the underlying channel/API:

- search member/contact
- add
- remove
- promote
- demote
- view members

Where supported.

Do not assume every WhatsApp account has every permission.

---

# 97. BULK MEMBER OPERATIONS

Example:

Select 100 groups.

Select support executive.

Action:

Add member.

Process via Job Center.

Show individual failures.

---

# 98. NEW GROUP AUTO-ONBOARDING

When new WhatsApp group is detected:

1. create group
2. map customer if possible
3. assign support profile
4. assign knowledge profile
5. assign automation profile
6. configure AI
7. configure monitoring
8. configure escalation
9. notify admin if required
10. mark onboarding complete

---

# 99. SMART GROUP ONBOARDING RULES

Example:

If group name contains:

"VIP"

Then:

Premium Support Profile.

If customer is in Zone A:

Standard Support.

Rules must be configurable.

---

# 100. DASHBOARD

Dashboard must show:

- total conversations
- open
- resolved
- human
- automation
- AI
- escalated
- response time
- resolution time
- AI success
- automation success
- active sessions
- monitored groups
- failed jobs
- AI failures
- knowledge gaps
- automation candidates

---

# 101. TOP ISSUES

Show:

- Software slow
- MikroTik
- Billing
- Invoice
- Reports
- Modules
- Installation

with trend.

---

# 102. INBOX REAL-TIME

Use WebSocket/SSE or existing event infrastructure.

Real-time:

- new message
- status
- AI state
- escalation
- job progress
- WhatsApp session

Do not use aggressive polling.

---

# 103. PAGINATION

Never load thousands of records into browser.

Use:

- server pagination
- cursor pagination where useful
- virtualized lists for large datasets

---

# 104. REPORTS

Reports:

Support Activity
Team Performance
AI Performance
Automation Performance
Escalations
Top Issues
Customer History
Group Activity
Broadcast
System Health

Exports:

CSV
Excel where useful
PDF where useful

---

# 105. AI REPORTS

Metrics:

- AI conversations
- successful AI resolutions
- human takeover
- escalations
- average confidence
- latency
- cost/tokens where provider supports
- failure intents
- knowledge gaps

---

# 106. AUTOMATION REPORTS

Metrics:

- triggers
- success
- failure
- human takeover
- customer follow-up
- resolution
- health score

---

# 107. AUDIT LOG

Record:

- login
- logout
- permission changes
- AI configuration
- automation activation
- knowledge approval
- bulk operations
- broadcasts
- member changes
- escalation
- emergency stop

Audit fields:

- actor
- action
- resource
- resource ID
- before
- after
- timestamp
- IP where appropriate
- metadata

---

# 108. RBAC

Roles:

Super Admin
Admin
Support Manager
Support Executive
AI Manager
Knowledge Manager
Report Viewer

Permissions:

groups.read
groups.update
groups.bulk_update
messages.read
messages.send
broadcast.create
broadcast.send
ai.configure
ai.execute
knowledge.create
knowledge.approve
automation.create
automation.approve
team.manage
reports.view
system.emergency_stop

---

# 109. SECURITY

Implement:

- authentication
- RBAC
- scoped API keys
- secure sessions
- encrypted secrets
- webhook validation
- rate limiting
- audit logs
- secure headers
- input validation
- file upload validation
- file size limits
- database least privilege
- no secrets in Git

---

# 110. DATA PRIVACY

Customer conversations are sensitive business data.

Use:

- least privilege
- access control
- secure storage
- controlled exports
- audit logs

Do not expose customer conversations to unauthorized users.

---

# 111. DATABASE

Use PostgreSQL.

Expected entities:

users
roles
permissions
user_roles
role_permissions

channel_accounts
whatsapp_accounts

customers
customer_contacts

groups
group_members
group_profiles

support_profiles
knowledge_profiles

conversations
conversation_participants
messages
message_attachments
message_reactions

knowledge_articles
knowledge_documents
knowledge_chunks
knowledge_versions

automation_rules
automation_conditions
automation_actions
automation_versions
automation_logs
automation_candidates

ai_providers
ai_configurations
ai_conversations
ai_messages
ai_escalations
ai_feedback
ai_candidates

team_members
support_activities
assignments

broadcasts
broadcast_recipients

jobs
job_items

tags
entity_tags

audit_logs
system_settings
custom_fields

decision_logs

conversation_state_history

---

# 112. MESSAGE DECISION LOG

This is mandatory.

For each automated decision record:

- message
- conversation
- matched automation
- knowledge retrieved
- AI enabled
- AI provider
- confidence
- policy result
- final decision
- response source
- escalation
- timestamp

Example:

Message:
"Mikrotik unreachable"

Decision:
AUTOMATION

Rule:
AUTO-102

AI:
NOT_CALLED

Reason:
Deterministic match.

Another:

Decision:
AI

Reason:
No deterministic match.

Confidence:
0.91

Knowledge:
KB-102

Another:

Decision:
HUMAN_ESCALATION

Reason:
Low confidence.

---

# 113. ADMIN DECISION INSPECTOR

Admin can open a message and see:

Incoming message
↓
Conversation state
↓
Matched automation
↓
Knowledge retrieved
↓
AI enabled
↓
AI decision
↓
Policy
↓
Final action

Never expose:

- API keys
- secrets
- sensitive credentials

---

# 114. DATABASE INDEXING

Indexes required for:

messages(conversation_id, timestamp)

messages(external_id)

conversations(group_id)

conversations(customer_id)

conversations(status)

groups(profile_id)

groups(ai_mode)

support_activities(team_member_id, date)

automation_logs(automation_id, date)

ai_messages(conversation_id)

jobs(status)

audit_logs(timestamp)

decision_logs(conversation_id, timestamp)

---

# 115. SEARCH

Support:

- message search
- customer search
- group search
- knowledge search

Use PostgreSQL full-text search where appropriate.

Use vector retrieval for AI knowledge.

Do not introduce Elasticsearch without demonstrated need.

---

# 116. API

Create:

/api/v1/auth
/api/v1/users
/api/v1/team
/api/v1/customers
/api/v1/groups
/api/v1/conversations
/api/v1/messages
/api/v1/knowledge
/api/v1/automation
/api/v1/ai
/api/v1/broadcasts
/api/v1/jobs
/api/v1/reports
/api/v1/settings
/api/v1/audit

Use:

- validation
- authorization
- pagination
- filtering
- sorting
- consistent errors

Generate OpenAPI documentation.

---

# 117. API IDEMPOTENCY

Use idempotency keys for:

- message send
- broadcast
- bulk jobs
- member operations

---

# 118. REAL-TIME EVENTS

Support:

- incoming messages
- outgoing status
- AI status
- conversation state
- escalation
- job progress
- WhatsApp connection

---

# 119. PERFORMANCE TARGET

Initial target:

3,000+ groups

Large message history.

Hundreds of thousands/millions of messages.

Multiple concurrent AI conversations.

Multiple support executives.

Bulk operations.

Design using:

- indexes
- queues
- workers
- caching
- pagination
- batching

---

# 120. MODULAR MONOLITH

Do not introduce microservices by default.

Recommended:

Backend
PostgreSQL
Redis
Worker

Optional:

MinIO
Reverse proxy

Keep domain modules isolated.

---

# 121. BACKGROUND WORKERS

Worker processes:

- AI requests
- document indexing
- broadcasts
- bulk group updates
- member operations
- reports
- cleanup
- analytics
- automation candidates

---

# 122. FAILURE HANDLING

Never silently fail.

Every failure must have:

- error code
- user-friendly message
- technical log
- retry status
- job ID if applicable

---

# 123. AI PROVIDER FAILURE

If provider fails:

1. timeout
2. retry asynchronously
3. exponential backoff
4. fallback provider if configured
5. automation fallback if possible
6. human escalation

Do not hammer a failed provider.

---

# 124. FEATURE FLAGS

Use flags for:

- AI
- broadcast
- bulk member operations
- AI-generated automation
- AI auto-activation
- external AI API
- future channels

---

# 125. CONFIGURATION

Use environment variables for:

DATABASE
REDIS
STORAGE
AI PROVIDERS
OPENWA
SECURITY
QUEUES
RATE LIMITS

Never hardcode secrets.

---

# 126. FILE STORAGE

Knowledge documents and media should use:

Development:
local storage

Production:
S3-compatible storage / MinIO where appropriate

Validate:

- MIME
- size
- extension
- filename
- storage path

---

# 127. DATA RETENTION

Allow configurable retention.

Support:

- archive
- cleanup
- export
- deletion policy

Do not automatically delete business data unless explicit policy exists.

---

# 128. BACKUP

Backup:

- PostgreSQL
- media
- knowledge documents
- configuration

Document:

- backup
- restore
- verification

---

# 129. OBSERVABILITY

Structured logs.

Include:

request ID
user ID
job ID
conversation ID
message ID
session
automation ID
AI request ID

Never log:

- API keys
- passwords
- access tokens
- secrets

---

# 130. HEALTH MONITORING

Monitor:

- WhatsApp
- database
- Redis
- workers
- AI provider
- storage
- queues

Status:

HEALTHY
WARNING
CRITICAL

---

# 131. FRONTEND UX

Professional CRM UI.

Requirements:

- responsive
- fast
- clean
- keyboard-friendly
- filters
- bulk selection
- pagination
- real-time
- clear status indicators
- dark/light support if compatible

Do not prioritize visual complexity over functionality.

---

# 132. BULK UX

Example:

Selected:
482 groups

Action:
Enable AI

Confirmation:

"This will enable AI for 482 groups."

Button:

Start Job

Then show:

Queued
Processing
Completed
Failed

---

# 133. IMPORT / EXPORT

CSV import/export for:

- team members
- customers
- group mapping
- knowledge metadata
- supported configuration

Validate before execution.

Show row-level errors.

---

# 134. NEW GROUP FLOW

New group detected.

System:

Detect
↓
Create
↓
Map
↓
Profile
↓
Knowledge
↓
Automation
↓
AI
↓
Monitoring
↓
Escalation
↓
Ready

---

# 135. AUTOMATION LEARNING FLOW

Historical conversations:

Analyze
↓
Cluster similar issues
↓
Identify repeated solution
↓
Create candidate
↓
Human review
↓
Approve
↓
Publish
↓
Track performance

---

# 136. AI LEARNING FLOW

Conversation:

AI response
↓
Human correction
↓
Feedback
↓
Candidate
↓
Review
↓
Knowledge/automation update

Never directly retrain production behavior from raw chat.

---

# 137. ADMIN AI CHATBOT

The admin AI assistant is an internal control interface.

It can:

- inspect reports
- inspect conversations
- inspect groups
- inspect automation
- inspect knowledge
- propose automation
- propose knowledge
- generate summaries

Write actions require confirmation.

---

# 138. AI COMMAND EXAMPLES

Admin:

"Show today's unresolved issues."

"Which group has the most escalations?"

"Create a draft automation for software slow."

"Why did AI escalate this conversation?"

"Show me automation candidates."

"How many groups have AI disabled?"

---

# 139. FUTURE CHANNEL SUPPORT

Do NOT implement Facebook/Messenger unless explicitly required now.

But architecture must allow:

WhatsApp
Facebook
Messenger
Facebook Pages
Other channels

All should eventually pass through:

Channel Adapter
↓
Message Decision Engine
↓
Automation
↓
Knowledge
↓
AI
↓
Human

---

# 140. TESTING STRATEGY

Implement:

Unit tests
Integration tests
API tests
Database tests
Automation tests
AI policy tests
Queue tests
RBAC tests
Webhook tests
Idempotency tests
E2E tests

---

# 141. CRITICAL TEST CASES

Test:

- duplicate webhook
- AI timeout
- AI provider failure
- WhatsApp disconnect
- queue retry
- human takeover
- AI resume
- bulk failure
- broadcast failure
- automation conflict
- permission denial
- emergency stop
- AI loop
- customer human request
- low confidence
- knowledge missing

---

# 142. E2E TEST 1

Customer:

"Hello"

Automation:

Greeting response.

AI:

NOT CALLED.

---

# 143. E2E TEST 2

Customer:

"Software slow"

Automation:

Troubleshooting + video.

AI:

NOT CALLED.

---

# 144. E2E TEST 3

Customer:

"Software slow হচ্ছে, সব করেছি।
Database server নিয়েও সমস্যা মনে হচ্ছে।"

Automation:

No suitable match.

Knowledge:

Retrieved.

AI:

Handles if confident.

---

# 145. E2E TEST 4

Customer:

"MikroTik unreachable"

Automation:

Troubleshooting.

Customer:

"সব করেছি, কাজ হচ্ছে না।"

AI:

Attempts contextual support.

AI:

Low confidence.

System:

HUMAN_REQUIRED.

Internal group:

Notified.

Executives:

Notified.

AI:

Stopped.

Human:

Takes over.

---

# 146. E2E TEST 5

Admin:

Select 500 groups.

Enable AI.

System:

Creates job.

Processes batches.

Shows progress.

Retries failures.

Reports result.

---

# 147. E2E TEST 6

AI:

Analyzes historical conversations.

Finds repeated issue.

Creates candidate.

Admin:

Reviews.

Edits.

Approves.

Automation:

Published.

---

# 148. E2E TEST 7

AI provider:

Unavailable.

System:

Detects failure.

Does not loop.

Uses fallback if configured.

Otherwise:

Escalates.

---

# 149. E2E TEST 8

Admin:

Emergency Stop AI.

System:

All AI disabled.

Outgoing AI queue stops.

Audit recorded.

Admin resumes.

System returns safely.

---

# 150. DOCKER

Production Docker architecture should contain:

support-crm
postgres
redis
worker

Optional:

minio
reverse proxy

Use persistent volumes.

Use health checks.

Use restart policies.

Use environment configuration.

---

# 151. DOCKER DEVELOPMENT

Provide:

docker-compose.yml

and where useful:

docker-compose.dev.yml
docker-compose.prod.yml

Development should be easy.

Production should be deterministic.

---

# 152. DATABASE MIGRATIONS

Use migrations.

Never use destructive database reset as normal deployment strategy.

Do not instruct production users to delete volumes to solve application migration problems.

---

# 153. DEPLOYMENT

Provide documentation for:

- VPS setup
- Docker
- environment variables
- PostgreSQL
- Redis
- OpenWA
- WhatsApp session
- AI provider
- storage
- reverse proxy
- SSL
- backup
- restore
- upgrades

---

# 154. DOCUMENTATION

Create:

README.md

docs/ARCHITECTURE.md

docs/DATABASE.md

docs/API.md

docs/DEPLOYMENT.md

docs/BACKUP.md

docs/AI.md

docs/AUTOMATION.md

docs/KNOWLEDGE.md

docs/SECURITY.md

docs/ADMIN.md

docs/TROUBLESHOOTING.md

---

# 155. DEVELOPMENT PHASES

## PHASE 0

Repository Audit.

Deliver:

- architecture map
- reusable components
- conflicts
- integration strategy
- proposed modules
- proposed database
- proposed events
- proposed queue
- implementation plan

Do not implement major features.

---

## PHASE 1

Foundation.

Implement:

- database
- migrations
- authentication
- RBAC
- audit
- channel abstraction
- configuration
- job architecture
- event architecture

---

## PHASE 2

WhatsApp.

Implement:

- OpenWA integration
- sessions
- groups
- contacts
- members
- messages
- webhooks/events
- inbox

---

## PHASE 3

CRM.

Implement:

- customers
- team
- assignments
- support activities
- tags
- conversation states

---

## PHASE 4

Knowledge.

Implement:

- articles
- documents
- indexing
- search
- versioning
- knowledge profiles

---

## PHASE 5

Automation.

Implement:

- rule engine
- conditions
- actions
- schedules
- cooldown
- simulator
- versioning
- analytics

---

## PHASE 6

AI.

Implement:

- provider abstraction
- configuration
- RAG
- memory
- decision engine
- confidence
- policies
- AI conversation

---

## PHASE 7

Human Escalation.

Implement:

- escalation
- internal groups
- executives
- takeover
- release
- AI pause
- safety
- kill switch

---

## PHASE 8

Scale.

Implement:

- bulk operations
- jobs
- broadcasts
- member operations
- onboarding
- rate limiting

---

## PHASE 9

Analytics.

Implement:

- dashboard
- team reports
- AI reports
- automation reports
- escalation reports
- knowledge gaps

---

## PHASE 10

AI Copilot.

Implement:

- admin chatbot
- command execution
- knowledge assistance
- automation candidates
- learning candidates

---

## PHASE 11

Hardening.

Implement:

- security audit
- performance
- tests
- Docker
- backups
- observability
- deployment documentation

---

# 156. PHASE RULE

At the beginning of each phase:

1. inspect code
2. identify reusable functionality
3. design
4. implement
5. migrate
6. test
7. lint
8. typecheck
9. build
10. document

Do not continue while critical tests are broken.

---

# 157. CODE QUALITY

Use:

- strict TypeScript
- dependency injection
- DTO validation
- clean modules
- domain services
- repositories where appropriate
- meaningful names
- testable functions
- clear boundaries

Avoid:

- giant services
- giant controllers
- `any`
- magic strings
- duplicated logic
- hardcoded secrets
- direct DB access from controllers
- direct OpenWA access from business modules

---

# 158. NO GOD MODULE

Do not create a single:

SupportService

containing everything.

Separate:

ConversationService
AutomationService
KnowledgeService
AIService
EscalationService
BroadcastService
GroupService
CustomerService
SupportActivityService
DecisionEngine
ChannelService

Use clear domain boundaries.

---

# 159. DECISION ENGINE AS CORE DOMAIN

The Message Decision Engine is one of the central domain services.

It coordinates:

- conversation state
- policy
- automation
- knowledge
- AI
- escalation
- outgoing actions

It must remain testable independently.

---

# 160. OUTGOING ACTION MODEL

Decision Engine should produce an action.

Examples:

AUTOMATION_REPLY
AI_REPLY
ESCALATE
NO_ACTION
WAIT
HUMAN_REQUIRED
PAUSE
RESOLVE

The outgoing messaging system executes the action.

---

# 161. DECISION ENGINE MUST NOT SEND DIRECTLY

Decision Engine decides.

Messaging service sends.

Example:

Decision Engine:

AI_REPLY

Messaging Service:

send through channel adapter.

This separation is mandatory.

---

# 162. POLICY ENGINE

Create centralized policies for:

- AI
- automation
- messaging
- broadcast
- escalation
- rate limits
- restricted actions

---

# 163. CUSTOMER EXPERIENCE PRINCIPLE

Customers should not feel like they are talking to a badly designed bot.

AI should:

- answer naturally
- use context
- avoid repetitive greetings
- not repeat already completed troubleshooting
- understand previous steps
- ask useful clarification questions
- escalate politely

---

# 164. AI RESPONSE STYLE

Avoid:

- unnecessary long replies
- repetitive text
- robotic wording
- unsupported technical claims
- excessive emoji
- exposing internal reasoning

---

# 165. INTERNAL AI REASONING

Never expose chain-of-thought.

Store only safe structured metadata such as:

- confidence
- decision
- knowledge IDs
- reason summary
- policy result

---

# 166. MESSAGE SOURCE LABELING

Every outgoing automated message should internally record:

MANUAL
AUTOMATION
AI
BROADCAST
SYSTEM

This enables reporting.

---

# 167. SUPPORT ACTIVITY SOURCE

Support activities should indicate:

HUMAN
AI_ASSISTED
AUTOMATION_ASSISTED

---

# 168. CONVERSATION TIMELINE

Conversation UI should clearly show:

Customer message
Automation response
AI response
Human response
Internal note
Escalation
State change

Use visual source indicators.

---

# 169. ADMIN DECISION DEBUGGING

Admin must be able to answer:

"Why did the system send this message?"

The system should show:

Rule matched
AI decision
Knowledge used
Policy
Conversation state
Final action

---

# 170. WHY DID AI NOT RESPOND?

Admin should be able to see:

AI disabled
Human active
Automation matched
Low confidence
Knowledge unavailable
Policy denied
Conversation paused
Provider unavailable
Rate limit
Emergency stop

---

# 171. WHY DID AI ESCALATE?

Show:

- confidence
- missing knowledge
- policy
- repeated attempts
- customer requested human
- AI max replies
- provider failure

---

# 172. WHY DID AUTOMATION NOT RUN?

Show:

- rule disabled
- schedule mismatch
- group mismatch
- keyword mismatch
- cooldown
- conversation state
- priority conflict
- monitoring disabled

---

# 173. SYSTEM RELIABILITY PRINCIPLE

Every important action must be:

Observable
Retryable where appropriate
Auditable
Idempotent where appropriate
Recoverable

---

# 174. PLATFORM LIMITATIONS

The system must respect the capabilities and limitations of the underlying WhatsApp integration.

Do not assume that every WhatsApp feature is technically available through OpenWA or the underlying transport.

If a requested feature is unsupported:

- detect capability
- disable/gray the feature
- explain limitation
- do not fake success

---

# 175. ACCOUNT SAFETY

Because WhatsApp integrations may have platform limitations or account risks:

Implement:

- rate limits
- batching
- configurable delays
- emergency stop
- audit
- session health
- failure handling
- conservative broadcast behavior

Do not build functionality intended to bypass WhatsApp platform restrictions.

---

# 176. FEATURE CAPABILITY SYSTEM

Channel adapter should expose capabilities.

Example:

canSendText
canSendMedia
canAddGroupMember
canRemoveGroupMember
canPin
canReact
canEdit
canDelete
canBroadcast
canReadGroupMembers

UI should respect capabilities.

---

# 177. API KEY SECURITY

External API keys:

- hashed or encrypted as appropriate
- scoped
- revocable
- rate limited
- audited

---

# 178. ADMIN SESSION SECURITY

Use:

- secure authentication
- session expiration
- refresh policy
- brute-force protection
- audit logging

---

# 179. FILE SECURITY

Uploaded documents must be:

- validated
- size limited
- sanitized
- stored outside executable paths
- access controlled

---

# 180. LOGGING

Use structured logging.

Example metadata:

requestId
conversationId
messageId
groupId
userId
jobId
aiRequestId
automationId

---

# 181. ERROR MONITORING

Provide meaningful error monitoring.

At minimum:

- application errors
- worker errors
- AI errors
- WhatsApp errors
- queue failures
- database errors

---

# 182. PERFORMANCE MONITORING

Track:

- webhook latency
- message processing latency
- queue latency
- AI latency
- database query latency
- outgoing message latency
- job duration

---

# 183. DATABASE RETENTION

Large message tables must be designed for growth.

Use:

- indexes
- archival
- retention policies
- partitioning only if justified by real scale

Do not prematurely introduce unnecessary database complexity.

---

# 184. CACHE

Redis may be used for:

- queues
- temporary state
- rate limiting
- locks
- caching
- job progress

Do not use Redis as the source of truth for permanent business data.

---

# 185. DISTRIBUTED LOCKS

Use appropriate locks where duplicate workers could cause:

- duplicate broadcast
- duplicate AI reply
- duplicate automation
- duplicate job execution

---

# 186. CONCURRENCY

Conversation-level concurrency must be controlled.

Avoid two workers simultaneously responding to the same conversation.

Use:

conversation lock / queue ordering

where necessary.

---

# 187. MESSAGE ORDER

Preserve message order where required.

AI should not answer message 2 before message 1 has been processed if ordering affects context.

---

# 188. CUSTOMER MESSAGE BURSTS

If customer sends:

Message 1
Message 2
Message 3

within a short time:

Optionally use a configurable debounce window.

Combine messages before AI processing.

Example:

Wait 2–5 seconds.

Then process combined context.

Do not use arbitrary delays without configuration.

---

# 189. AI RESPONSE COOLDOWN

Prevent AI from sending multiple responses in rapid succession.

Use configurable cooldown.

---

# 190. HUMAN PRIORITY

Human messages always have higher priority than AI.

If a human responds:

AI must not race the human.

---

# 191. AUTOMATION VS HUMAN

If a human has recently responded, automation may be suppressed based on conversation policy.

Default:

Human response pauses AI and conflicting automation.

---

# 192. CUSTOMER EXPERIENCE PROTECTION

Never send:

- duplicate replies
- contradictory replies
- AI + automation answers simultaneously
- stale answers after human takeover

---

# 193. CONVERSATION LOCK

Before automated response:

Acquire conversation processing lock.

Validate state again.

Then send.

This prevents race conditions.

---

# 194. OUTGOING VALIDATION

Before sending:

Check:

- conversation state
- AI state
- automation state
- emergency state
- rate limit
- duplicate
- permission
- channel capability

Only then send.

---

# 195. MESSAGE DELIVERY STATUS

Track where supported:

queued
sent
delivered
read
failed

Do not invent unsupported statuses.

---

# 196. BROADCAST AUDIENCE PREVIEW

Before sending:

Show:

Recipients:
482

Excluded:
17

Estimated:
465

Allow test send.

---

# 197. BROADCAST CANCELLATION

Scheduled broadcasts can be cancelled before execution.

Queued broadcasts should support cancellation where possible.

---

# 198. KNOWLEDGE APPROVAL

Knowledge can have:

Draft
Review
Published
Archived

Only Published knowledge is available to production AI unless explicitly configured otherwise.

---

# 199. AUTOMATION APPROVAL

Automation:

Draft
Review
Published
Paused
Archived

Only Published automation can execute.

---

# 200. AI CONFIGURATION APPROVAL

If AI configuration is changed:

Audit:

old configuration
new configuration
actor
time

Potentially require confirmation for production changes.

---

# 201. PRODUCTION SAFETY

Never deploy:

- debug mode
- default credentials
- plaintext secrets
- unrestricted CORS
- disabled authentication
- unprotected admin APIs

---

# 202. ENVIRONMENT SEPARATION

Support:

development
staging
production

Do not use production credentials in development.

---

# 203. SEED DATA

Development seed data may include:

- sample users
- sample groups
- sample automation
- sample knowledge
- sample conversations

Do not seed fake production credentials.

---

# 204. MIGRATION SAFETY

Every migration:

- reviewed
- tested
- logged
- reversible where practical

---

# 205. DEPLOYMENT CHECKLIST

Before production:

- environment configured
- database migrated
- Redis healthy
- worker healthy
- OpenWA healthy
- WhatsApp connected
- AI configured
- storage configured
- backups configured
- health checks working
- audit enabled
- emergency controls tested

---

# 206. ACCEPTANCE CRITERIA

The project is complete only when:

1. WhatsApp connects.
2. QR login works where supported.
3. Messages arrive.
4. Messages persist.
5. Duplicate messages are prevented.
6. Inbox works.
7. Human replies work.
8. Groups work.
9. Customers work.
10. Team works.
11. Support activities work.
12. Knowledge works.
13. Documents index.
14. Automation works.
15. Scheduling works.
16. Cooldowns work.
17. AI works.
18. AI retrieves knowledge.
19. AI decision engine works.
20. Confidence policy works.
21. Human escalation works.
22. Internal escalation group works.
23. Executive escalation works.
24. Human takeover works.
25. Release to AI works.
26. AI loop protection works.
27. Emergency stop works.
28. Bulk groups work.
29. Bulk jobs work.
30. Broadcast works safely.
31. Member management works where channel capability exists.
32. New group onboarding works.
33. AI learning candidates work.
34. Automation candidates work.
35. Knowledge candidates work.
36. Reports work.
37. Audit logs work.
38. RBAC works.
39. Docker build works.
40. Backup documentation exists.
41. Restore documentation exists.
42. API documentation exists.
43. Tests cover critical flows.
44. Performance is acceptable for 3,000+ groups.
45. Future channels can be added without rewriting core business logic.

---

# 207. PHASE 0 DELIVERABLE

Before implementation, create:

docs/ARCHITECTURE_AUDIT.md

Include:

1. Existing OpenWA architecture
2. Existing database
3. Existing APIs
4. Existing WhatsApp functionality
5. Existing events
6. Existing queues
7. Existing authentication
8. Existing dashboard
9. Existing Docker
10. Reusable components
11. Extension points
12. Conflicts
13. Support CRM architecture
14. Domain modules
15. Database changes
16. Event flow
17. Queue flow
18. Security risks
19. Implementation phases

---

# 208. IMPLEMENTATION PLAN

Create:

docs/IMPLEMENTATION_PLAN.md

For every phase include:

- objectives
- modules
- files/modules affected
- database migrations
- APIs
- UI
- tests
- dependencies
- completion criteria

---

# 209. NO FAKE COMPLETION

Never claim:

"Implemented"

if only:

- UI exists
- endpoint is stubbed
- mock data exists
- TODO exists
- fake WhatsApp response exists

A feature is complete only when its actual behavior works.

---

# 210. NO MOCK PRODUCTION LOGIC

Mock data may be used for UI development.

But final production paths must use:

real database
real queue
real OpenWA integration
real AI provider abstraction
real automation engine
real permissions

---

# 211. NO UNNECESSARY REWRITES

Preserve working OpenWA functionality.

If modifying OpenWA:

- document reason
- isolate changes
- add tests
- preserve compatibility where practical

---

# 212. BACKWARD COMPATIBILITY

Before changing an existing OpenWA API:

Inspect:

- consumers
- tests
- dashboard
- SDK
- documentation

Prefer extension over breaking change.

---

# 213. FINAL SYSTEM BEHAVIOR

The final system should behave like:

Customer sends message.

↓

System validates message.

↓

Conversation state is checked.

↓

Deterministic automation is evaluated.

↓

If known and safe:

Automation replies.

↓

If no deterministic match:

Knowledge is retrieved.

↓

If AI is disabled:

Human escalation or configured fallback.

↓

If AI is enabled:

AI Decision Engine evaluates.

↓

If high confidence + grounded + policy allows:

AI replies.

↓

If clarification is needed:

AI asks useful clarification.

↓

If low confidence / unsupported / sensitive:

Human escalation.

↓

Internal group is notified.

↓

Configured executives are notified.

↓

Conversation becomes HUMAN_REQUIRED.

↓

AI stops.

↓

Human takes over.

↓

Human resolves.

↓

Conversation outcome is stored.

↓

System analyzes the conversation.

↓

Potential automation/knowledge candidate is generated.

↓

Human reviews.

↓

Human approves.

↓

System improves.

---

# 214. CORE PHILOSOPHY

This platform is not simply:

"WhatsApp + AI"

It is:

WhatsApp
+
CRM
+
Knowledge
+
Automation
+
AI
+
Human Support
+
Analytics
+
Learning Loop
+
Safety

The system should continuously reduce repetitive support workload while preserving human control.

---

# 215. FINAL ARCHITECTURAL PRINCIPLE

The most important principle is:

KNOWN + SAFE + DETERMINISTIC
→ AUTOMATION

KNOWN + CONTEXTUAL
→ AI WITH KNOWLEDGE

UNKNOWN BUT SAFE AND AI CAN HANDLE
→ AI

UNKNOWN / LOW CONFIDENCE / RESTRICTED
→ HUMAN

HUMAN ACTIVE
→ AI OFF

EMERGENCY
→ KILL SWITCH

---

# 216. FIRST COMMAND TO THE CODING AGENT

After reading this file completely, do NOT immediately start implementing the full product.

First:

1. Inspect the repository.
2. Audit OpenWA.
3. Map existing functionality.
4. Identify reusable components.
5. Identify integration boundaries.
6. Identify architectural conflicts.
7. Create `docs/ARCHITECTURE_AUDIT.md`.
8. Create `docs/IMPLEMENTATION_PLAN.md`.
9. Propose the final module structure.
10. Propose database changes.
11. Propose event/queue architecture.
12. Propose OpenWA integration strategy.
13. Verify that the plan follows this specification.

Do not ask unnecessary questions.

Make reasonable technical decisions autonomously.

Only ask for clarification when a genuine business decision cannot be inferred safely.

After Phase 0 is complete, begin Phase 1.

---

# 217. FINAL COMMAND

Treat this file as the canonical specification for Support CRM.

Do not selectively implement only the UI.

Do not simplify away critical architecture.

Do not replace deterministic automation with AI unnecessarily.

Do not allow AI to bypass human safety controls.

Do not allow bulk operations to block HTTP requests.

Do not allow duplicate messages.

Do not allow AI and humans to race each other.

Do not expose secrets.

Do not create fake production functionality.

Build the foundation first.

Then build the intelligence layer.

Then build the scale layer.

Then harden the system.

The final result must be a maintainable, production-grade Support CRM capable of handling thousands of WhatsApp support groups while combining automation, knowledge, AI, and human support in a reliable and configurable way.