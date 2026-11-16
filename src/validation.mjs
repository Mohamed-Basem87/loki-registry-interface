export class RequestError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "RequestError";
    this.statusCode = statusCode;
  }
}

export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/g, "");
}

export function validateRegistration({ id, name }) {
  const cleanId = String(id || "").trim();
  const cleanName = String(name || "").trim();

  if (!/^[a-z0-9_]{1,60}$/.test(cleanId)) {
    throw new RequestError(
      'ID must be lowercase snake_case (for example, "graphic_design") and at most 60 characters.',
    );
  }
  if (cleanId === "done") {
    throw new RequestError('"done" is reserved for the sender picker.');
  }
  if (!cleanName || cleanName.length > 200) {
    throw new RequestError("Name must contain 1 to 200 characters.");
  }

  return { id: cleanId, name: cleanName };
}

export function addSourceToProject(projectText, source) {
  let project;
  try {
    project = JSON.parse(projectText);
  } catch {
    throw new RequestError("Loki's project.json is not valid JSON.", 502);
  }

  if (!Array.isArray(project.sources)) {
    throw new RequestError(
      'Loki config does not contain a "sources" array.',
      502,
    );
  }

  const existing = project.sources.find((item) => item.id === source.id);
  if (existing) {
    if (existing.display_name === source.name) {
      return { text: projectText, changed: false };
    }
    throw new RequestError(
      `Source ID "${source.id}" already exists with a different name.`,
      409,
    );
  }

  project.sources.push({
    id: source.id,
    display_name: source.name,
    aliases: [source.id],
  });

  return {
    text: `${JSON.stringify(project, null, 2)}\n`,
    changed: true,
  };
}

function pythonString(value) {
  return JSON.stringify(value);
}

export function categoryScaffold({ id, name }) {
  const qualifiedName = pythonString(name);
  const qualifiedId = pythonString(id);
  const keywordFile = [
    "POSITIVE_KEYWORDS = {}",
    "NEGATIVE_KEYWORDS = {}",
    "HARD_REJECT_KEYWORDS = set()",
    "NOISE_KEYWORDS = set()",
    "",
    "",
    "def _all_scored_keywords():",
    "    for polarity in (POSITIVE_KEYWORDS, NEGATIVE_KEYWORDS):",
    "        for group in polarity.values():",
    '            for tier in ("core", "supporting"):',
    "                for keyword in group.get(tier, {}):",
    "                    yield keyword",
    "",
    "",
    "def _validate_keyword_tables():",
    "    collisions = NOISE_KEYWORDS.intersection(_all_scored_keywords())",
    "    if collisions:",
    "        raise AssertionError(",
    '            f"NOISE_KEYWORDS overlap scored keywords: {sorted(collisions)}"',
    "        )",
    "",
    "",
    "_validate_keyword_tables()",
    "",
  ].join("\n");

  return {
    "__init__.py": '"""Category package scaffold."""\n',
    "keywords.py": keywordFile,
    "profile.py": [
      "from app.domain.categories.profile import CategoryProfile",
      "",
      "from .keywords import POSITIVE_KEYWORDS, NEGATIVE_KEYWORDS, HARD_REJECT_KEYWORDS",
      "",
      "PROFILE = CategoryProfile(",
      `    id=${qualifiedId},`,
      `    name=${qualifiedName},`,
      '    description="Classification guidance pending manual completion.",',
      '    arbitration_context="Classification guidance pending manual completion.",',
      "    positive_keywords=POSITIVE_KEYWORDS,",
      "    negative_keywords=NEGATIVE_KEYWORDS,",
      "    hard_reject_keywords=HARD_REJECT_KEYWORDS,",
      `    guard_prompt_module="app.domain.categories.${id}.guard_prompt",`,
      ")",
      "",
    ].join("\n"),
    "llm_prompt.py": [
      "SYSTEM_PROMPT = " + pythonString(
        `Category: ${name} (${id}). This scaffold is not configured yet. A developer must add category-specific scope and evaluation guidance before relying on model arbitration.`,
      ),
      "",
    ].join("\n"),
    "guard_prompt.py": [
      "SYSTEM_PROMPT = " + pythonString(
        `Category: ${name} (${id}). This scaffold is not configured yet. Reject until a developer adds category-specific guard guidance.`,
      ),
      "",
    ].join("\n"),
  };
}
