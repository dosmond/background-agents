import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const key = request.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }

  const userId = session.user.id || session.user.email || "anonymous";
  const range = request.headers.get("range");

  try {
    const response = await controlPlaneFetch(
      `/sessions/${id}/artifacts/content?key=${encodeURIComponent(key)}&userId=${encodeURIComponent(userId)}`,
      {
        method: "GET",
        headers: range ? { Range: range } : undefined,
      }
    );

    const headers = new Headers();
    const passthroughHeaders = [
      "content-type",
      "content-length",
      "cache-control",
      "accept-ranges",
      "content-range",
    ];
    for (const headerName of passthroughHeaders) {
      const value = response.headers.get(headerName);
      if (value) headers.set(headerName, value);
    }

    return new NextResponse(response.body, {
      status: response.status,
      headers,
    });
  } catch (error) {
    console.error("Failed to fetch artifact content:", error);
    return NextResponse.json({ error: "Failed to fetch artifact content" }, { status: 500 });
  }
}
