import type { ReactElement, ReactNode } from "react";
import { LanguageContext } from "../shared/i18n/react";
import { fireEvent, render as renderUI, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { SessionActions } from "./SessionActions";

const props = () => ({ pendingCount: 0, bringing: false, pinned: false, archived: false,
    onBringBack: vi.fn(), onOpen: vi.fn(), onPin: vi.fn(), onDeactivate: vi.fn(), onArchive: vi.fn() });

test("waiting cards expose handled in the menu; other states omit it", () => {
    const actions = props(), handled = vi.fn();
    const { rerender } = render(<SessionActions {...actions} onHandled={handled}/>);
    const trigger = screen.getByRole("button", { name: "更多会话操作" });
    fireEvent.click(trigger); fireEvent.click(screen.getByRole("menuitem", { name: "已处理" }));
    expect(handled).toHaveBeenCalledOnce(); expect(trigger).toHaveFocus(); expect(screen.queryByRole("menu")).toBeNull();
    rerender(<SessionActions {...actions}/>); fireEvent.click(trigger);
    expect(screen.queryByRole("menuitem", { name: "已处理" })).toBeNull();
});

test("menu is keyboard accessible, cycles focus, restores trigger on Escape and activates with Enter", async () => {
    const user = userEvent.setup(), actions = props();
    render(<SessionActions {...actions}/>);
    const trigger = screen.getByRole("button", { name: "更多会话操作" });
    expect(screen.queryByRole("menu")).toBeNull();
    trigger.focus();
    await user.keyboard("{Enter}");
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}"); expect(items[3]).toHaveFocus();
    await user.keyboard("{ArrowDown}"); expect(items[0]).toHaveFocus();
    await user.keyboard("{End}"); expect(items[3]).toHaveFocus();
    await user.keyboard("{Home}"); expect(items[0]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull(); expect(trigger).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(actions.onPin).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull(); expect(trigger).toHaveFocus();
});

test("outside pointer and tabbing away dismiss the menu without invoking an action", async () => {
    const user = userEvent.setup(), actions = props();
    render(<><SessionActions {...actions}/><button>外部按钮</button></>);
    const trigger = screen.getByRole("button", { name: "更多会话操作" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "外部按钮" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(trigger);
    await user.keyboard("{End}{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "外部按钮" })).toHaveFocus();
    expect(actions.onPin).not.toHaveBeenCalled();
    expect(actions.onArchive).not.toHaveBeenCalled();
});

test("T19 primary uses every pending idea and only-open lives in the overflow menu", () => {
    const actions = props();
    const { rerender } = render(<SessionActions {...actions}/>);
    const open = screen.getByRole("button", { name: "打开原会话" });
    expect(open).toHaveClass("primary-action");
    fireEvent.click(open); expect(actions.onOpen).toHaveBeenCalledOnce();
    expect(actions.onBringBack).not.toHaveBeenCalled();
    rerender(<SessionActions {...actions} pendingCount={3} pinned/>);
    fireEvent.click(screen.getByRole("button", { name: "带回 3 条" }));
    expect(actions.onBringBack).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "只打开原会话" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "只打开原会话" }));
    expect(actions.onOpen).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "更多会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "取消钉住" }));
    expect(actions.onPin).toHaveBeenCalledOnce();
    rerender(<SessionActions {...actions} pendingCount={3} bringing/>);
    expect(screen.getByRole("button", { name: "带回 3 条" })).toBeDisabled();
});

function render(ui: ReactElement) { return renderUI(ui, { wrapper: ({ children }: { children: ReactNode }) => <LanguageContext.Provider value="zh">{children}</LanguageContext.Provider> }); }
