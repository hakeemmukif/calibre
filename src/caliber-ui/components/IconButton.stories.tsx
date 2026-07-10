import type { Meta, StoryObj } from "@storybook/react";
import { IconButton, type IconButtonVariant, type IconButtonSize } from "./IconButton";

const meta: Meta<typeof IconButton> = {
  title: "Primitives/IconButton",
  component: IconButton,
};
export default meta;
type Story = StoryObj<typeof IconButton>;

const variants: IconButtonVariant[] = ["ghost", "soft", "soft-accent"];
const sizes: IconButtonSize[] = ["sm", "md", "lg"];

export const Default: Story = {
  args: { icon: "pencil", label: "Edit job" },
};

export const AllVariantsAndSizes: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {variants.map((variant) => (
        <div key={variant} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 90, font: "var(--type-caption)", color: "var(--text-muted)" }}>{variant}</span>
          {sizes.map((size) => (
            <IconButton key={size} variant={variant} size={size} icon="sparkles" label="Tailor with AI" />
          ))}
        </div>
      ))}
    </div>
  ),
};

export const Toolbar: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 6 }}>
      <IconButton icon="pencil" label="Edit" />
      <IconButton icon="copy" label="Duplicate" />
      <IconButton icon="download" label="Export" />
      <IconButton icon="x" label="Withdraw application" />
    </div>
  ),
};
