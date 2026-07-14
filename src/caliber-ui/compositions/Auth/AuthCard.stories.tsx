import type { Meta, StoryObj } from "@storybook/react";
import { AuthCard } from "./AuthCard";

const meta: Meta<typeof AuthCard> = {
  title: "Compositions/Auth/AuthCard",
  component: AuthCard,
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof AuthCard>;

const onSubmitLog = (email: string, password: string) => console.log(email, password);

export const Login: Story = {
  args: {
    mode: "login",
    onSubmit: onSubmitLog,
    busy: false,
    switchHref: "/register",
    switchLabel: "Create an account",
  },
};

export const Register: Story = {
  args: {
    mode: "register",
    onSubmit: onSubmitLog,
    busy: false,
    switchHref: "/login",
    switchLabel: "Sign in instead",
  },
};

export const WithError: Story = {
  args: {
    mode: "login",
    onSubmit: onSubmitLog,
    busy: false,
    error: "Invalid email or password.",
    switchHref: "/register",
    switchLabel: "Create an account",
  },
};

export const Busy: Story = {
  args: {
    mode: "login",
    onSubmit: onSubmitLog,
    busy: true,
    switchHref: "/register",
    switchLabel: "Create an account",
  },
};
