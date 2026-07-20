"use client";
import * as React from "react";
import { initAnalytics } from "./client";

// Mounted once in the root layout; renders nothing. initAnalytics guards
// against double-invoke (React StrictMode runs effects twice in dev).
export function PostHogInit(): null {
  React.useEffect(() => {
    initAnalytics();
  }, []);
  return null;
}
