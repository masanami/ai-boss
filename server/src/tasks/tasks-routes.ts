import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import { insertTask, listTasks, updateTask } from "./tasks-repository.js";
import {
  validateCreateTaskInput,
  validatePatchTaskInput,
} from "./tasks-validation.js";

/**
 * Creates the tasks sub-router, mounted under `/api/tasks` by the caller.
 */
export function createTasksRouter(db: Database.Database): Hono {
  const tasks = new Hono();

  tasks.get("/", (c) => {
    return c.json(listTasks(db));
  });

  tasks.post("/", async (c) => {
    const body = await readJsonBody(c);

    const result = validateCreateTaskInput(body);
    if (!result.valid) {
      return c.json({ error: result.error }, 400);
    }

    const task = insertTask(db, result.data);
    return c.json(task, 201);
  });

  tasks.patch("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await readJsonBody(c);

    const result = validatePatchTaskInput(body);
    if (!result.valid) {
      return c.json({ error: result.error }, 400);
    }

    const task = updateTask(db, id, result.data);
    if (!task) {
      return c.json({ error: `task ${id} not found` }, 404);
    }

    return c.json(task);
  });

  return tasks;
}
