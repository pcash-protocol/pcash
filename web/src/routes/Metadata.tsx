import { useEffect } from "react";

export interface MetadataProps {
  title: string;
  description: string;
  type?: "website" | "article";
}

export function Metadata({ title, description, type = "website" }: MetadataProps) {
  const completeTitle = title === "PCASH" ? title : `${title} · PCASH`;
  useEffect(() => {
    const titleElement = document.head.querySelector("title") ?? document.head.appendChild(document.createElement("title"));
    titleElement.dataset.pcashRouteMetadata = "true";
    titleElement.textContent = completeTitle;
    const setMeta = (attribute: "name" | "property", key: string, content: string) => {
      const selector = `meta[${attribute}="${key}"]`;
      const element = document.head.querySelector<HTMLMetaElement>(selector) ?? document.head.appendChild(document.createElement("meta"));
      element.dataset.pcashRouteMetadata = "true";
      element.setAttribute(attribute, key);
      element.content = content;
    };
    setMeta("name", "description", description);
    setMeta("property", "og:type", type);
    setMeta("property", "og:title", completeTitle);
    setMeta("property", "og:description", description);
    setMeta("name", "twitter:title", completeTitle);
    setMeta("name", "twitter:description", description);
  }, [completeTitle, description, type]);
  return null;
}
