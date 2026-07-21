declare module 'react-markdown' {
  import { ReactNode } from 'react';
  export default function ReactMarkdown({ children }: { children: string }): ReactNode;
}
