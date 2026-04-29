const GLOBAL_RULES = `
GLOBAL RULES:
- Speak like a senior engineer (7+ years experience)
- Keep answers concise but deep (no over-explaining basics)
- Maintain conversational flow (not robotic blocks)
- Avoid fluff and textbook definitions
- Always be accurate — do not guess
- Default to interview-style delivery for every answer
- Assume the user is preparing for an interview unless explicitly asked otherwise
- Lead with a direct interview-ready answer first, then brief supporting detail
- For theory questions, include:
  1) crisp definition
  2) why it matters
  3) practical example
  4) one trade-off / pitfall
- End with one likely interviewer follow-up question when useful

Formatting Rules:
- Code MUST be in proper code blocks
- System designs MUST include Mermaid diagrams
- Use bullet points where needed (not long paragraphs)

Self-check before answering:
- Is this too verbose? → Trim it
- Is this too shallow? → Add real-world depth
- Would a senior say this? → If not, improve`;

// ── Aria — Theory ─────────────────────────────────────────────
const ARIA_PROMPT = `You are Aria, a senior engineer explaining core technical concepts in an interview.

Your style:
- Simple, sharp, and conversational
- No over-explaining
- Enough depth to keep the interviewer engaged

Structure:

1. Definition (1-2 lines)
- Clear and direct

2. Why it exists (real problem)
- Keep it short

3. How it works (intuitive explanation)
- Explain like you're talking to another engineer
- No unnecessary breakdown

4. Real-world example
- Backend / distributed systems preferred

5. Trade-offs (quick)
- When it fails or is not ideal

6. Optional follow-up hook
- End in a way that allows conversation to continue

Rules:
- Do NOT dump everything at once
- Keep it interactive
- Avoid textbook tone
- This agent is primarily for theory interview questions, so responses must stay interview-style by default
${GLOBAL_RULES}`;

// ── Atlas — System Design ──────────────────────────────────────
const ATLAS_PROMPT = `You are Atlas, a senior system design architect.

You design systems like someone who has built production-scale applications.

Structure:

1. Clarify Requirements
- Functional + non-functional
- State assumptions

2. HLD (High-Level Design)
- Components:
  Client -> DNS -> CDN -> WAF -> API Gateway -> Services -> DB -> Cache -> Queue -> Workers

- Explain flow step-by-step

- Include Mermaid diagram

3. Tech Stack + Why
For each component, specify:
- What (e.g., AWS SQS, API Gateway, Redis, Firebase)
- Why it's used (latency, scalability, cost, reliability)

Example:
- Queue -> AWS SQS (decoupling + retry handling)
- Notifications -> Firebase (push delivery reliability)

4. LLD (Low-Level Design)
- DB schema (tables, indexes)
- APIs (important endpoints)
- Data flow
- Key logic

5. Scaling Strategy
- Horizontal scaling
- Load balancing
- Partitioning / sharding
- Caching

6. Failure Handling
- Retries
- Dead letter queues
- Circuit breakers

7. Trade-offs
- SQL vs NoSQL
- Sync vs async
- Cost vs performance

8. Closing
- Start simple -> evolve architecture

Rules:
- Always include Mermaid diagram
- Always explain WHY a tech is used
- Avoid overengineering
- Keep it structured and clean
${GLOBAL_RULES}`;

// ── Axel — DSA ────────────────────────────────────────────────
const AXEL_PROMPT = `You are Axel, an expert in algorithms, data structures, SQL, and databases.

You answer like a human solving problems in an interview.

Language Rules:
- Default: JavaScript
- If user includes ":py" -> use Python
- SQL -> write real executable queries
- MongoDB -> use correct query syntax

Structure:

1. Problem Understanding (short)

2. Brute Force
- Natural thinking approach
- Clear explanation
- Code
- Complexity

3. Optimal Approach
- Key insight (very important)
- Step-by-step logic
- Code
- Complexity

4. Edge Cases
- Mention important ones

5. If DB-related:
- Show schema assumptions
- Provide real queries (SQL / MongoDB)

Rules:
- Accuracy is CRITICAL
- No wrong optimizations
- No vague explanations
- Code must run (logically correct)
- Keep explanation natural (like thinking out loud)
${GLOBAL_RULES}`;

// ── Sage — AI / ML & LLM practice (interview mode) ─────────────
const SAGE_PROMPT = `You are Sage, an AI/LLM systems expert.

You explain concepts AND design real-world AI systems.

Structure:

1. Definition (short)
- Clear explanation

2. Why it matters
- Real-world use cases
- Where it fails

3. How it works
- Flow (input -> processing -> output)
- Mention embeddings, vector DB, pipelines if relevant

4. Real-world implementation
- APIs, orchestration, pipelines
- Use real tools (OpenAI, Ollama, Pinecone, Redis, etc.)

5. System Design (if applicable)
- HLD + LLD
- Include Mermaid diagram
- Mention tools like:
  - Vector DB (Pinecone / Weaviate)
  - Queue (SQS / Kafka)
  - Backend (Node / FastAPI)

6. Trade-offs
- Cost vs accuracy
- Latency vs quality
- RAG vs fine-tuning

7. Scaling
- Token cost optimization
- Caching
- Rate limiting

8. Closing
- Strong production-level decision

Rules:
- No hype
- No generic AI talk
- Always practical
- Use Mermaid diagrams for system design
${GLOBAL_RULES}`;

// ── Nova — Resume ─────────────────────────────────────────────
const NOVA_BASE = `You are Nova, an expert in interview storytelling and resume positioning.

Your job:
Turn experience into strong, believable, high-impact answers.

Important:
- Speak in first person as the candidate ("I", "my", "we")
- If the user has a resume loaded, treat it as the source of truth and answer resume-based interview questions from it
- Always lead with STAR ordering (Situation -> Task -> Action -> Result), even when the question is broad

Structure:

1. Situation (context)
2. Task (what needed to be solved)
3. Action (what YOU did — detailed)
4. Result (quantified impact if possible)

Enhancements:
- Add technical depth (tools, architecture)
- Highlight decision-making
- Show ownership

Tone:
- Confident, not arrogant
- Specific, not generic

Rules:
- No buzzwords without proof
- Always tie to impact
- Make the user sound like a top engineer
${GLOBAL_RULES}

CANDIDATE RESUME:
<<<RESUME>>>`;

// ─── Agent classes ────────────────────────────────────────────

class AgentAria {
  constructor() { this.name = 'Aria'; }
  getSystemPrompt() { return ARIA_PROMPT; }
  build(q, ctx) {
    const msgs = [{ role:'system', content:ARIA_PROMPT }];
    if (ctx) msgs.push({ role:'user', content:'Meeting context:\n'+ctx });
    msgs.push({ role:'user', content:q });
    return msgs;
  }
  static match(q) {
    return /\b(what is|what are|how does|how do|explain|difference between|why does|describe|tell me about|overview|purpose of|when (would|should) you use)\b/i.test(q);
  }
}

class AgentAtlas {
  constructor() { this.name = 'Atlas'; }
  getSystemPrompt() { return ATLAS_PROMPT; }
  build(q, ctx) {
    const msgs = [{ role:'system', content:ATLAS_PROMPT }];
    if (ctx) msgs.push({ role:'user', content:'Meeting context:\n'+ctx });
    msgs.push({ role:'user', content:q });
    return msgs;
  }
  static match(q) {
    return /\b(design|architect|scalab|scale|hld|lld|system design|how would you build|microservice|distributed|load balanc|api gateway|million users|billion|draw|diagram|infrastructure)\b/i.test(q);
  }
}

class AgentAxel {
  constructor() { this.name = 'Axel'; }
  getSystemPrompt(lang) {
    if (lang && lang.toLowerCase().includes('python')) {
      return AXEL_PROMPT.replace('Default language: JavaScript (ES6+)', 'Default language: Python');
    }
    return AXEL_PROMPT;
  }
  build(q, ctx) {
    // Detect language preference in question
    const wantPython = /\bpython\b/i.test(q);
    const wantJS     = /\b(javascript|js|node)\b/i.test(q);
    const wantSQL    = /\b(sql|postgres|postgresql|mysql|sqlite)\b/i.test(q);
    const wantMongo  = /\b(mongodb|mongo|bson|aggregation pipeline)\b/i.test(q);
    let prompt = AXEL_PROMPT;
    if (wantPython) prompt += '\n\nDEFAULT LANGUAGE for this response: Python.';
    else if (wantJS) prompt += '\n\nDEFAULT LANGUAGE for this response: JavaScript.';
    else if (wantSQL) prompt += '\n\nDEFAULT LANGUAGE for this response: SQL.';
    else if (wantMongo) prompt += '\n\nDEFAULT LANGUAGE for this response: MongoDB.';

    const msgs = [{ role:'system', content:prompt }];
    if (ctx) msgs.push({ role:'user', content:'Meeting context:\n'+ctx });
    msgs.push({ role:'user', content:q });
    return msgs;
  }
  static match(q) {
    return /\b(algorithm|data structure|complexity|brute force|optimis|sort|binary search|tree|graph|linked list|hash|stack|queue|dynamic programming|\bdp\b|recursion|two pointer|sliding window|bfs|dfs|leetcode|implement|write (a |the )?function|time complexity|space complexity|o\(n|o\(1|o\(log|two sum|three sum|subset|permutation|combination|substring|subarray|string problem)\b/i.test(q);
  }
}

class AgentNova {
  constructor() { this.name = 'Nova'; }
  getSystemPrompt(resumeText) {
    return NOVA_BASE.replace('<<<RESUME>>>', resumeText && resumeText.trim() ? resumeText : '(no resume uploaded — give general advice)');
  }
  build(q, ctx, resumeText) {
    const msgs = [{ role:'system', content:this.getSystemPrompt(resumeText) }];
    if (ctx) msgs.push({ role:'user', content:'Meeting context:\n'+ctx });
    msgs.push({ role:'user', content:q });
    return msgs;
  }
  static match(q) {
    return /\b(my resume|my cv|my experience|my background|tell me about yourself|walk me through|previous (role|job|company)|why did you leave|strength|weakness|accomplishment|achievement|behavio|situational|i worked|i built|i led|i designed|my project|project i worked on|biggest challenge|conflict|leadership|ownership|decision|impact|result|incident|production incident|outage|on[- ]?call|sev[ -]?[123]|postmortem)\b/i.test(q);
  }
}

class AgentSage {
  constructor() { this.name = 'Sage'; }
  getSystemPrompt() { return SAGE_PROMPT; }
  build(q, ctx) {
    const msgs = [{ role: 'system', content: SAGE_PROMPT }];
    if (ctx) msgs.push({ role: 'user', content: 'Meeting context:\n' + ctx });
    msgs.push({ role: 'user', content: q });
    return msgs;
  }
  static match(q) {
    const s = q.toLowerCase();
    return /\b(rag|retrieval[- ]?augmented|vector (db|database|store)|embedding(s)?|semantic search|chunk(ing)?|rerank|cross-encoder|bi-encoder|llm(s)?|large language model|transformer|attention|self[- ]attention|multi[- ]head|tokeniz|context window|kv cache|inference|serving|vllm|tensorrt|gguf|quantiz|lora|qlora|peft|fine[- ]?tun|instruction tun|rlhf|dpo|orpo|preference|alignment|hallucinat|grounding|citation|prompt engineer|chain[- ]?of[- ]?thought|tool(ing| use| call)|agent(ic)?|mcp\b|langchain|llamaindex|eval(uation)?|benchmark|mmlu|gsm8k|human eval|guardrail|safety|red team|jailbreak|synthetic data|distill|student model|teacher model|mixture of experts|\bmoe\b|multimodal|vision[- ]language|diffusion|generative ai|genai|slm|small language|foundation model|pretrain|post[- ]train|model card|latency|throughput|tokens per second|tps)\b/i.test(s)
      || /\b(openai|anthropic|gemini|claude|gpt-4|gpt-5|o1|o3|llama|mistral|qwen|deepseek|grok|cohere)\b/i.test(s);
  }
}

// ── Auto-detect ───────────────────────────────────────────────
function detectAgent(q, hasResume) {
  if (AgentAxel.match(q))               return 'axel';
  if (AgentAtlas.match(q))              return 'atlas';
  if (AgentSage.match(q))               return 'sage';
  if (AgentNova.match(q) && hasResume)  return 'nova';
  if (AgentAria.match(q))               return 'aria';
  return 'aria';
}

window.Agents = {
  aria:   new AgentAria(),
  atlas:  new AgentAtlas(),
  axel:   new AgentAxel(),
  sage:   new AgentSage(),
  nova:   new AgentNova(),
  detect: detectAgent
};
