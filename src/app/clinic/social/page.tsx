import { PhotoFolders } from "../PhotoFolders";

export default function SocialMedia({ searchParams }: { searchParams: Promise<{ month?: string; branch?: string; q?: string }> }) {
  return <PhotoFolders social={true} searchParams={searchParams} />;
}
