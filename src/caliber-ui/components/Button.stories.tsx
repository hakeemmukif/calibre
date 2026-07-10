import type { Meta, StoryObj } from "@storybook/react";
import { Button, type ButtonVariant, type ButtonSize } from "./Button";

const meta: Meta<typeof Button> = {
  title: "Primitives/Button",
  component: Button,
};
export default meta;
type Story = StoryObj<typeof Button>;

const variants: ButtonVariant[] = ["primary", "secondary", "soft", "soft-accent", "accent", "ghost"];
const sizes: ButtonSize[] = ["sm", "md", "lg"];

export const Default: Story = {
  args: { children: "Apply now", variant: "primary", size: "md" },
};

export const AllVariantsAndSizes: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {variants.map((variant) => (
        <div key={variant} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 100, font: "var(--type-caption)", color: "var(--text-muted)" }}>{variant}</span>
          {sizes.map((size) => (
            <Button key={size} variant={variant} size={size}>
              {size === "sm" ? "Save" : size === "md" ? "Apply now" : "Tailor resume"}
            </Button>
          ))}
        </div>
      ))}
    </div>
  ),
};

export const WithIcons: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 12 }}>
      <Button variant="primary" iconLeft="send">Submit application</Button>
      <Button variant="soft-accent" iconLeft="sparkles">Tailor with AI</Button>
      <Button variant="secondary" iconRight="arrow-right">View job</Button>
      <Button variant="ghost" disabled>Withdrawn</Button>
    </div>
  ),
};
