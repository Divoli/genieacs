/**
 * Copyright 2013-2019  GenieACS Inc.
 *
 * This file is part of GenieACS.
 *
 * GenieACS is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * GenieACS is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with GenieACS.  If not, see <http://www.gnu.org/licenses/>.
 */

import { ObjectID } from "mongodb";
import * as db from "./db";
import { del } from "../cache";
import { getUsers } from "../local-cache";
import { hashPassword } from "../auth";
import {
  insertTasks,
  watchTask,
  connectionRequest,
  deleteDevice,
} from "../api-functions";
import { Task } from "../types";
import * as logger from "../logger";

async function deleteFault(id): Promise<void> {
  const deviceId = id.split(":", 1)[0];
  const channel = id.slice(deviceId.length + 1);

  await Promise.all([
    db.deleteFault(id),
    channel.startsWith("task_")
      ? db.deleteTask(new ObjectID(channel.slice(5)))
      : null,
  ]);

  await del(`${deviceId}_tasks_faults_operations`);
}

export async function deleteResource(
  resource: string,
  id: string
): Promise<void> {
  switch (resource) {
    case "devices":
      await deleteDevice(id);
      break;

    case "files":
      await db.deleteFile(id);
      break;

    case "faults":
      await deleteFault(id);
      break;

    case "provisions":
      await db.deleteProvision(id);
      break;

    case "presets":
      await db.deletePreset(id);
      break;

    case "virtualParameters":
      await db.deleteVirtualParameter(id);
      break;

    case "config":
      await db.deleteConfig(id);
      break;

    case "permissions":
      await db.deletePermission(id);
      break;

    case "users":
      await db.deleteUser(id);
      break;
  }

  await del("presets_hash");
}

export async function postTasks(
  deviceId: string,
  tasks: Task[],
  timeout: number,
  device: Record<string, { value?: [boolean | number | string, string] }>
): Promise<{ connectionRequest: string; tasks: any[] }> {
  logger.info({
    message: `Posting tasks for ${deviceId} with timeout ${timeout}`,
  });

  for (const task of tasks) {
    delete task._id;
    task["device"] = deviceId;
  }

  tasks = await insertTasks(tasks);
  const statuses = tasks.map((t) => {
    return { _id: t._id, status: "pending" };
  });

  await del(`${deviceId}_tasks_faults_operations`);

  try {
    await connectionRequest(deviceId, device);
  } catch (err) {
    logger.error({
      message: "Failed to request connection",
      error: err.message.trim(),
    });
    await Promise.all(statuses.map((t) => db.deleteTask(new ObjectID(t._id))));
    return {
      connectionRequest: err.message,
      tasks: statuses,
    };
  }

  const sample = tasks[tasks.length - 1];

  // Waiting for session to finish or timeout
  await watchTask(deviceId, sample._id, timeout);

  const promises = [];
  for (const s of statuses) {
    promises.push(db.query("tasks", ["=", ["PARAM", "_id"], s._id]));
    promises.push(
      db.query("faults", ["=", ["PARAM", "_id"], `${deviceId}:task_${s._id}`])
    );
  }

  const res = await Promise.all(promises);
  for (const [i, r] of statuses.entries()) {
    if (res[i * 2].length === 0) {
      r.status = "done";
    } else if (res[i * 2 + 1].length === 1) {
      r.status = "fault";
      r["fault"] = res[i * 2 + 1][0];
    }
  }

  await Promise.all(statuses.map((t) => db.deleteTask(new ObjectID(t._id))));

  return { connectionRequest: "OK", tasks: statuses };
}

export async function putResource(
  resource: string,
  id: string,
  data: Record<string, unknown>
): Promise<void> {
  if (resource === "presets") {
    await db.putPreset(id, data);
  } else if (resource === "provisions") {
    await db.putProvision(id, data);
  } else if (resource === "virtualParameters") {
    await db.putVirtualParameter(id, data);
  } else if (resource === "config") {
    await db.putConfig(id, data);
  } else if (resource === "permissions") {
    await db.putPermission(id, data);
  } else if (resource === "users") {
    delete data["password"];
    delete data["salt"];
    await db.putUser(id, data);
  }

  await del("presets_hash");
}

export function authLocal(
  snapshot: string,
  username: string,
  password: string
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const users = getUsers(snapshot);
    const user = users[username];
    if (!user || !user.password) return void resolve(null);
    hashPassword(password, user.salt)
      .then((hash) => {
        if (hash === user.password) resolve(true);
        else resolve(false);
      })
      .catch(reject);
  });
}
