"use client";

import * as React from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

import { cn } from "../../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface ComboboxOption {
  value: string;
  label: string;
  icon?: string;
}

export interface MultiSelectComboboxProps {
  options: ComboboxOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
}

export function MultiSelectCombobox({
  options,
  selected,
  onChange,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  className,
}: MultiSelectComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const filtered = React.useMemo(() => {
    if (!search) return options;
    const lower = search.toLowerCase();
    return options.filter((o) => {
      return o.label.toLowerCase().includes(lower);
    });
  }, [options, search]);

  const selectedSet = React.useMemo(() => {
    return new Set(selected);
  }, [selected]);

  function toggle(value: string) {
    if (selectedSet.has(value)) {
      onChange(
        selected.filter((v) => {
          return v !== value;
        }),
      );
    } else {
      onChange([...selected, value]);
    }
  }

  function remove(value: string, e: React.SyntheticEvent) {
    e.stopPropagation();
    onChange(
      selected.filter((v) => {
        return v !== value;
      }),
    );
  }

  const selectedOptions = React.useMemo(() => {
    return selected
      .map((v) => {
        return options.find((o) => {
          return o.value === v;
        });
      })
      .filter((o): o is ComboboxOption => {
        return o !== undefined;
      });
  }, [selected, options]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setSearch("");
        }
      }}
    >
      <PopoverTrigger
        nativeButton={false}
        render={
          <div
            role="combobox"
            aria-expanded={open}
            tabIndex={0}
            className={cn(
              "flex min-h-9 w-full cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-input px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10",
              className,
            )}
          >
            <div className="flex flex-1 flex-wrap items-center gap-1">
              {selectedOptions.length > 0 ? (
                selectedOptions.map((opt) => {
                  return (
                    <span
                      key={opt.value}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-xs font-medium"
                    >
                      {opt.icon && (
                        <OptionIcon src={opt.icon} alt={opt.label} size={14} />
                      )}
                      {opt.label}
                      <span
                        role="button"
                        tabIndex={0}
                        className="ml-0.5 rounded-sm text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          return remove(opt.value, e);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            remove(opt.value, e);
                          }
                        }}
                        aria-label={`Remove ${opt.label}`}
                      >
                        <X size={12} />
                      </span>
                    </span>
                  );
                })
              ) : (
                <span className="text-muted-foreground">{placeholder}</span>
              )}
            </div>
            <ChevronDown size={16} className="shrink-0 text-muted-foreground" />
          </div>
        }
      />
      <PopoverContent
        className="w-[var(--anchor-width)] p-0"
        align="start"
        initialFocus={searchInputRef}
        finalFocus={false}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => {
              return setSearch(e.target.value);
            }}
            placeholder={searchPlaceholder}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No results found
            </p>
          ) : (
            filtered.map((opt) => {
              const isSelected = selectedSet.has(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground outline-none transition-colors hover:bg-state-hover hover:text-accent-foreground"
                  onClick={() => {
                    return toggle(opt.value);
                  }}
                >
                  {opt.icon && (
                    <OptionIcon src={opt.icon} alt={opt.label} size={16} />
                  )}
                  <span className="flex-1 text-left">{opt.label}</span>
                  {isSelected && (
                    <Check size={16} className="shrink-0 text-brand-text" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function OptionIcon({
  src,
  alt,
  size,
}: {
  src: string;
  alt: string;
  size: number;
}) {
  const [error, setError] = React.useState(false);

  if (error) return null;

  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className="shrink-0 object-contain"
      onError={() => {
        return setError(true);
      }}
    />
  );
}
