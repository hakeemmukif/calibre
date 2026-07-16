import type { Meta, StoryObj } from "@storybook/react";
import { AdminUsersTable } from "./AdminUsersTable";
import type { AdminUser } from "../../../types";

const meta: Meta<typeof AdminUsersTable> = {
  title: "Compositions/Admin/AdminUsersTable",
  component: AdminUsersTable,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof AdminUsersTable>;

const users: AdminUser[] = [
  {
    id: "u1",
    email: "admin@caliber.dev",
    role: "admin",
    createdAt: "2026-01-05T09:00:00.000Z",
    resumeCount: 1,
    jobCount: 42,
    applicationCount: 12,
    balance: 0,
    plan: "unlimited",
  },
  {
    id: "u2",
    email: "alice@example.com",
    role: "user",
    createdAt: "2026-02-14T09:00:00.000Z",
    resumeCount: 1,
    jobCount: 30,
    applicationCount: 4,
    balance: 45,
    plan: "standard",
  },
  {
    id: "u3",
    email: "bob@example.com",
    role: "user",
    createdAt: "2026-03-20T09:00:00.000Z",
    resumeCount: 0,
    jobCount: 12,
    applicationCount: 0,
    balance: 0,
    plan: "standard",
  },
];

const onGrantLog = (id: string, delta: number) => console.log(id, delta);
const onTogglePlanLog = (id: string, nextPlan: "standard" | "unlimited") => console.log(id, nextPlan);

export const Populated: Story = {
  args: { users, onGrant: onGrantLog, onTogglePlan: onTogglePlanLog },
};

export const Empty: Story = {
  args: { users: [], onGrant: onGrantLog, onTogglePlan: onTogglePlanLog },
};
