import { RequestError, addSourceToProject, categoryScaffold, validateRegistration } from "./validation.mjs";

function categoryPaths(id) {
  return [
    `app/domain/categories/${id}/__init__.py`,
    `app/domain/categories/${id}/keywords.py`,
    `app/domain/categories/${id}/profile.py`,
    `app/domain/categories/${id}/llm_prompt.py`,
    `app/domain/categories/${id}/guard_prompt.py`,
  ];
}

async function commitAfterSenderRegistration(senderResult, commit) {
  try {
    return await commit();
  } catch (error) {
    const prefix = senderResult.created
      ? "The sender registered the ID, but the GitHub commit failed."
      : "The ID already exists in the sender, but the GitHub commit failed.";
    throw new RequestError(`${prefix} ${error.message}`, 502);
  }
}

export async function registerSource({ id, name }, { sender, github }) {
  const source = validateRegistration({ id, name });
  const snapshot = await github.readProjectConfig();
  const update = addSourceToProject(snapshot.text, source);
  const senderResult = await sender.ensure("sources", source);

  const commit = update.changed
    ? await commitAfterSenderRegistration(senderResult, () =>
        github.commitFiles(
          snapshot.baseSha,
          [{ path: "config/project.json", content: update.text }],
          `Register source ${source.id}`,
        ),
      )
    : null;

  return {
    id: source.id,
    name: source.name,
    senderCreated: senderResult.created,
    commit,
  };
}

export async function registerCategory({ id, name }, { sender, github }) {
  const category = validateRegistration({ id, name });
  const paths = categoryPaths(category.id);
  const existing = await github.readFiles(paths);
  const files = categoryScaffold(category);
  const anyExisting = existing.files.some((entry) => entry.exists);
  const matchesScaffold =
    existing.files.length === Object.keys(files).length &&
    existing.files.every((entry) => {
      const fileName = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      return entry.exists && entry.content === files[fileName];
    });

  if (anyExisting && !matchesScaffold) {
    throw new RequestError(
      `Category package "${category.id}" already exists in Loki.`,
      409,
    );
  }

  const senderResult = await sender.ensure("categories", category);
  const commit = matchesScaffold
    ? null
    : await commitAfterSenderRegistration(senderResult, () =>
        github.commitFiles(
          existing.baseSha,
          Object.entries(files).map(([file, content]) => ({
            path: `app/domain/categories/${category.id}/${file}`,
            content,
          })),
          `Scaffold category ${category.id}`,
        ),
      );

  return {
    id: category.id,
    name: category.name,
    senderCreated: senderResult.created,
    commit,
  };
}
