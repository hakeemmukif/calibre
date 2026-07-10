import type { Meta, StoryObj } from "@storybook/react";
import { ResumeView } from "./ResumeView";
import { ResumeUpload } from "./ResumeUpload";
import { resume } from "../../fixtures";
import { Resume } from "../../../types";

const meta: Meta<typeof ResumeView> = {
  title: "Compositions/Resume/ResumeView",
  component: ResumeView,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ResumeView>;

const noop = () => console.log("action");

export const Populated: Story = {
  args: { resume, onTailor: noop, onReupload: noop },
};

const longResume = Resume.parse({
  ...resume,
  experience: [
    ...resume.experience,
    {
      title: "Backend Engineer Intern",
      company: "MDEC",
      dates: "2019–2020",
      bullets: ["Built an internal reporting dashboard in Node.js.", "Wrote integration tests for the grants API."],
    },
    {
      title: "Teaching Assistant, Data Structures",
      company: "Universiti Malaya",
      dates: "2018–2019",
      bullets: ["Graded assignments for a 200-student cohort.", "Ran weekly lab sessions on algorithms."],
    },
  ],
  skills: [...resume.skills, "Redis", "gRPC", "Terraform", "GraphQL", "CI/CD", "Kubernetes"],
});

export const Long: Story = {
  args: { resume: longResume, onTailor: noop, onReupload: noop },
};

const lowAtsResume = Resume.parse({ ...resume, atsScore: 34 });

export const LowATS: Story = {
  args: { resume: lowAtsResume, onTailor: noop, onReupload: noop },
};

// Empty — before a résumé exists, the Resume page embeds ResumeUpload
// directly (GET /api/resume 404s; there is no ResumeView to render yet).
export const Empty: Story = {
  render: () => <ResumeUpload status="idle" onFile={() => console.log("onFile")} />,
};
