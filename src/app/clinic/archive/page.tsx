import { PhotoFolders } from "../PhotoFolders";

export default function ClientArchive({ searchParams }: { searchParams: Promise<{ month?: string; branch?: string; q?: string }> }) {
  return <PhotoFolders social={false} searchParams={searchParams} />;
}
