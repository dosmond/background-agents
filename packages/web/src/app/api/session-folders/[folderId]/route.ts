import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || session?.user?.email || null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { folderId } = await params;
  try {
    const body = await request.json();
    const response = await controlPlaneFetch(
      `/session-folders/${encodeURIComponent(userId)}/${encodeURIComponent(folderId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: body.name }),
      }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to rename session folder:", error);
    return NextResponse.json({ error: "Failed to rename session folder" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || session?.user?.email || null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { folderId } = await params;
  try {
    const response = await controlPlaneFetch(
      `/session-folders/${encodeURIComponent(userId)}/${encodeURIComponent(folderId)}`,
      {
        method: "DELETE",
      }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to delete session folder:", error);
    return NextResponse.json({ error: "Failed to delete session folder" }, { status: 500 });
  }
}
