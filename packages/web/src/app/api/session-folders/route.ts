import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || session?.user?.email || null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const response = await controlPlaneFetch(`/session-folders/${encodeURIComponent(userId)}`);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch session folders:", error);
    return NextResponse.json({ error: "Failed to fetch session folders" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || session?.user?.email || null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const response = await controlPlaneFetch(`/session-folders/${encodeURIComponent(userId)}`, {
      method: "POST",
      body: JSON.stringify({
        repoOwner: body.repoOwner,
        repoName: body.repoName,
        name: body.name,
      }),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to create session folder:", error);
    return NextResponse.json({ error: "Failed to create session folder" }, { status: 500 });
  }
}
