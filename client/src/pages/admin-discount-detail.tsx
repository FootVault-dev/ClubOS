import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { useState, useEffect } from "react";
import { formatCurrency } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimePickerInput } from "@/components/ui/time-picker-input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, Tag, RefreshCw, Wand2, Trash2, Copy } from "lucide-react";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Discount, Program } from "@shared/schema";

type DiscountType = "amount_off_product" | "amount_off_order" | "buy_x_get_y" | "free_shipping";

const typeInfo: Record<DiscountType, { label: string; description: string }> = {
  amount_off_product: { label: "Amount off products", description: "Discount specific products or collections of products" },
  amount_off_order: { label: "Amount off order", description: "Discount the total order amount" },
  buy_x_get_y: { label: "Buy X get Y", description: "Buy specific products or collections of products" },
  free_shipping: { label: "Free shipping", description: "Offer free shipping on an order" },
};

function generateCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

function formatDateForInput(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().split("T")[0];
}

function formatTimeForInput(d: Date | string | null | undefined): string {
  if (!d) return "09:00";
  const date = typeof d === "string" ? new Date(d) : d;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export default function AdminDiscountDetail() {
  const [, navigate] = useLocation();
  const [matchNew] = useRoute("/admin/discounts/new");
  const [matchEdit, params] = useRoute("/admin/discounts/:id");
  const isNew = matchNew;
  const editId = matchEdit ? parseInt(params!.id) : null;
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id || 1;
  const { toast } = useToast();

  const [showTypeSelector, setShowTypeSelector] = useState(false);
  const [discountType, setDiscountType] = useState<DiscountType>("amount_off_order");
  const [method, setMethod] = useState<"code" | "automatic">("code");
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [valueType, setValueType] = useState<"percentage" | "fixed_amount">("percentage");
  const [value, setValue] = useState("");
  const [appliesTo, setAppliesTo] = useState("all");
  const [selectedCampIds, setSelectedCampIds] = useState<number[]>([]);
  const [eligibility, setEligibility] = useState("all");
  const [customerEmails, setCustomerEmails] = useState("");
  const [minPurchaseType, setMinPurchaseType] = useState("none");
  const [minPurchaseValue, setMinPurchaseValue] = useState("");
  const [minQuantity, setMinQuantity] = useState("");
  const [maxTotalUses, setMaxTotalUses] = useState("");
  const [limitTotalUses, setLimitTotalUses] = useState(false);
  const [onePerCustomer, setOnePerCustomer] = useState(false);
  const [combinesWithProduct, setCombinesWithProduct] = useState(false);
  // Default ON so a newly-created code stacks with the club's automatic discounts
  // (early bird / multi-team). Editing an existing discount loads its real value.
  const [combinesWithOrder, setCombinesWithOrder] = useState(true);
  const [startDate, setStartDate] = useState(formatDateForInput(new Date()));
  const [startTime, setStartTime] = useState(formatTimeForInput(new Date()));
  const [hasEndDate, setHasEndDate] = useState(false);
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("23:59");
  const [status, setStatus] = useState("active");

  const { data: existingDiscount, isLoading: loadingDiscount } = useQuery<Discount>({
    queryKey: ["/api/admin/discounts", editId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/discounts/${editId}`);
      if (!r.ok) throw new Error("Not found");
      return r.json();
    },
    enabled: !!editId,
  });

  const { data: camps } = useQuery<Program[]>({
    queryKey: ["/api/admin/camps"],
  });

  const orgCamps = (camps || []).filter(c => c.organizationId === orgId);

  useEffect(() => {
    if (existingDiscount) {
      setDiscountType(existingDiscount.type as DiscountType);
      setMethod(existingDiscount.method as "code" | "automatic");
      setTitle(existingDiscount.title);
      setCode(existingDiscount.code || "");
      setValueType(existingDiscount.valueType as "percentage" | "fixed_amount");
      setValue(String(existingDiscount.value));
      setAppliesTo(existingDiscount.appliesTo);
      setSelectedCampIds(existingDiscount.campIds || []);
      setEligibility(existingDiscount.eligibility);
      setCustomerEmails((existingDiscount.customerEmails || []).join(", "));
      setMinPurchaseType(existingDiscount.minPurchaseType);
      setMinPurchaseValue(existingDiscount.minPurchaseValue ? String(existingDiscount.minPurchaseValue) : "");
      setMinQuantity(existingDiscount.minQuantity ? String(existingDiscount.minQuantity) : "");
      setLimitTotalUses(!!existingDiscount.maxTotalUses);
      setMaxTotalUses(existingDiscount.maxTotalUses ? String(existingDiscount.maxTotalUses) : "");
      setOnePerCustomer(existingDiscount.onePerCustomer);
      setCombinesWithProduct(existingDiscount.combinesWithProduct);
      setCombinesWithOrder(existingDiscount.combinesWithOrder);
      setStartDate(formatDateForInput(existingDiscount.startDate));
      setStartTime(formatTimeForInput(existingDiscount.startDate));
      setHasEndDate(!!existingDiscount.endDate);
      setEndDate(existingDiscount.endDate ? formatDateForInput(existingDiscount.endDate) : "");
      setEndTime(existingDiscount.endDate ? formatTimeForInput(existingDiscount.endDate) : "23:59");
      setStatus(existingDiscount.status);
    }
  }, [existingDiscount]);

  useEffect(() => {
    if (isNew) setShowTypeSelector(true);
  }, [isNew]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const startDateStr = startDate ? new Date(`${startDate}T${startTime}:00`).toISOString() : new Date().toISOString();
      const endDateStr = hasEndDate && endDate ? new Date(`${endDate}T${endTime}:00`).toISOString() : null;

      const payload = {
        organizationId: orgId,
        title: title || (method === "code" ? code : `${discountType} discount`),
        code: method === "code" ? code.toUpperCase() : null,
        type: discountType,
        method,
        valueType: discountType === "free_shipping" ? "percentage" as const : valueType,
        value: discountType === "free_shipping" ? "100" : value,
        appliesTo: discountType === "amount_off_product" ? appliesTo : "all",
        campIds: appliesTo === "specific_camps" ? selectedCampIds : null,
        eligibility,
        customerEmails: eligibility === "specific_customers" && customerEmails
          ? customerEmails.split(",").map(e => e.trim()).filter(Boolean)
          : null,
        minPurchaseType,
        minPurchaseValue: minPurchaseType === "min_amount" ? minPurchaseValue : null,
        minQuantity: minPurchaseType === "min_quantity" ? parseInt(minQuantity) || null : null,
        maxTotalUses: limitTotalUses && maxTotalUses ? parseInt(maxTotalUses) : null,
        onePerCustomer,
        combinesWithProduct,
        combinesWithOrder,
        startDate: startDateStr,
        endDate: endDateStr,
        status,
      };

      if (editId) {
        return apiRequest("PATCH", `/api/admin/discounts/${editId}`, payload);
      } else {
        return apiRequest("POST", "/api/admin/discounts", payload);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/discounts"] });
      toast({ title: editId ? "Discount updated" : "Discount created" });
      navigate("/admin/discounts");
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/admin/discounts/${editId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/discounts"] });
      toast({ title: "Discount deleted" });
      navigate("/admin/discounts");
    },
  });

  if (editId && loadingDiscount) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-5 h-5 animate-spin text-white/30" />
      </div>
    );
  }

  const summaryItems: string[] = [];
  if (eligibility === "all") summaryItems.push("All customers");
  else summaryItems.push("Specific customers only");
  if (minPurchaseType === "none") summaryItems.push("No minimum purchase requirement");
  else if (minPurchaseType === "min_amount") summaryItems.push(`Minimum purchase $${minPurchaseValue}`);
  else summaryItems.push(`Minimum ${minQuantity} items`);
  if (!limitTotalUses && !onePerCustomer) summaryItems.push("No usage limits");
  if (limitTotalUses && maxTotalUses) summaryItems.push(`Limit of ${maxTotalUses} total uses`);
  if (onePerCustomer) summaryItems.push("One use per customer");
  if (!combinesWithProduct && !combinesWithOrder) summaryItems.push("Can't combine with other discounts");
  else {
    if (combinesWithProduct) summaryItems.push("Combines with product discounts");
    if (combinesWithOrder) summaryItems.push("Combines with order discounts");
  }
  if (startDate) {
    if (hasEndDate && endDate) {
      summaryItems.push(`Active from ${startDate} to ${endDate}`);
    } else {
      summaryItems.push(`Active from ${startDate}`);
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/admin/discounts")}
          className="text-white/40 hover:text-white/60 rounded-xl"
          data-testid="button-back"
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-white" data-testid="text-page-title">
            {isNew ? "Create discount" : existingDiscount?.title || "Edit discount"}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {editId && (
            <Button
              variant="outline"
              onClick={() => deleteMutation.mutate()}
              className="border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-xl gap-2"
              data-testid="button-delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => navigate("/admin/discounts")}
            className="border-white/10 text-white/60 rounded-xl"
            data-testid="button-discard"
          >
            Discard
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || (!code && method === "code") || !value}
            className="bg-blue-600 hover:bg-blue-700 text-white rounded-xl"
            data-testid="button-save"
          >
            {saveMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="premium-card border-white/[0.06]">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-white/80">
                {typeInfo[discountType]?.label || "Discount"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <Label className="text-white/50 text-xs font-medium">Method</Label>
                <div className="flex gap-2 mt-1.5">
                  <Button
                    variant={method === "code" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setMethod("code")}
                    className={method === "code"
                      ? "bg-blue-600 text-white rounded-lg"
                      : "border-white/10 text-white/50 rounded-lg"}
                    data-testid="button-method-code"
                  >
                    Discount code
                  </Button>
                  <Button
                    variant={method === "automatic" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setMethod("automatic")}
                    className={method === "automatic"
                      ? "bg-blue-600 text-white rounded-lg"
                      : "border-white/10 text-white/50 rounded-lg"}
                    data-testid="button-method-automatic"
                  >
                    Automatic discount
                  </Button>
                </div>
              </div>

              {method === "code" && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <Label className="text-white/50 text-xs font-medium">Discount code</Label>
                    <button
                      onClick={() => setCode(generateCode())}
                      className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                      data-testid="button-generate-code"
                    >
                      <Wand2 className="w-3 h-3" />
                      Generate random code
                    </button>
                  </div>
                  <Input
                    value={code}
                    onChange={e => setCode(e.target.value.toUpperCase())}
                    placeholder="e.g. SUMMER20"
                    className="premium-input text-white/80 rounded-xl font-mono"
                    data-testid="input-code"
                  />
                  <p className="text-xs text-white/30 mt-1">Customers must enter this code at checkout.</p>
                </div>
              )}

              {method === "automatic" && (
                <div>
                  <Label className="text-white/50 text-xs font-medium mb-1.5 block">Title</Label>
                  <Input
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="e.g. Summer Sale 20% Off"
                    className="premium-input text-white/80 rounded-xl"
                    data-testid="input-title"
                  />
                  <p className="text-xs text-white/30 mt-1">Customers will see this in their cart.</p>
                </div>
              )}

              {method === "code" && (
                <div>
                  <Label className="text-white/50 text-xs font-medium mb-1.5 block">Title (optional)</Label>
                  <Input
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="e.g. Summer Promo"
                    className="premium-input text-white/80 rounded-xl"
                    data-testid="input-title-code"
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {discountType !== "free_shipping" && (
            <Card className="premium-card border-white/[0.06]">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-white/80">Discount value</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-3">
                  <Select value={valueType} onValueChange={v => setValueType(v as "percentage" | "fixed_amount")}>
                    <SelectTrigger className="w-44 premium-input text-white/80 rounded-xl" data-testid="select-value-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percentage">Percentage</SelectItem>
                      <SelectItem value="fixed_amount">Fixed amount</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="relative flex-1">
                    <Input
                      type="number"
                      value={value}
                      onChange={e => setValue(e.target.value)}
                      placeholder={valueType === "percentage" ? "10" : "5.00"}
                      className="premium-input text-white/80 rounded-xl pr-8"
                      data-testid="input-value"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">
                      {valueType === "percentage" ? "%" : "$"}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {discountType === "amount_off_product" && (
            <Card className="premium-card border-white/[0.06]">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-white/80">Applies to</CardTitle>
              </CardHeader>
              <CardContent>
                <RadioGroup value={appliesTo} onValueChange={setAppliesTo} className="space-y-3">
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="all" id="applies-all" />
                    <Label htmlFor="applies-all" className="text-sm text-white/70">All camps/products</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="specific_camps" id="applies-specific" />
                    <Label htmlFor="applies-specific" className="text-sm text-white/70">Specific camps</Label>
                  </div>
                </RadioGroup>
                {appliesTo === "specific_camps" && (
                  <div className="mt-3 space-y-2 max-h-48 overflow-y-auto border border-white/[0.06] rounded-lg p-3">
                    {orgCamps.length === 0 ? (
                      <p className="text-xs text-white/30">No camps available</p>
                    ) : (
                      orgCamps.map(camp => (
                        <label key={camp.id} className="flex items-center gap-2 cursor-pointer" data-testid={`camp-option-${camp.id}`}>
                          <Checkbox
                            checked={selectedCampIds.includes(camp.id)}
                            onCheckedChange={checked => {
                              setSelectedCampIds(prev =>
                                checked ? [...prev, camp.id] : prev.filter(id => id !== camp.id)
                              );
                            }}
                          />
                          <span className="text-sm text-white/70">{camp.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="premium-card border-white/[0.06]">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-white/80">Eligibility</CardTitle>
            </CardHeader>
            <CardContent>
              <RadioGroup value={eligibility} onValueChange={setEligibility} className="space-y-3">
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="all" id="elig-all" />
                  <Label htmlFor="elig-all" className="text-sm text-white/70">All customers</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="specific_customers" id="elig-specific" />
                  <Label htmlFor="elig-specific" className="text-sm text-white/70">Specific customers</Label>
                </div>
              </RadioGroup>
              {eligibility === "specific_customers" && (
                <div className="mt-3">
                  <Label className="text-white/50 text-xs font-medium mb-1.5 block">Customer emails (comma separated)</Label>
                  <Input
                    value={customerEmails}
                    onChange={e => setCustomerEmails(e.target.value)}
                    placeholder="email1@example.com, email2@example.com"
                    className="premium-input text-white/80 rounded-xl"
                    data-testid="input-customer-emails"
                  />
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="premium-card border-white/[0.06]">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-white/80">Minimum purchase requirements</CardTitle>
            </CardHeader>
            <CardContent>
              <RadioGroup value={minPurchaseType} onValueChange={setMinPurchaseType} className="space-y-3">
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="none" id="min-none" />
                  <Label htmlFor="min-none" className="text-sm text-white/70">No minimum requirements</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="min_amount" id="min-amount" />
                  <Label htmlFor="min-amount" className="text-sm text-white/70">Minimum purchase amount ($)</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="min_quantity" id="min-quantity" />
                  <Label htmlFor="min-quantity" className="text-sm text-white/70">Minimum quantity of items</Label>
                </div>
              </RadioGroup>
              {minPurchaseType === "min_amount" && (
                <div className="mt-3">
                  <div className="relative max-w-xs">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
                    <Input
                      type="number"
                      value={minPurchaseValue}
                      onChange={e => setMinPurchaseValue(e.target.value)}
                      placeholder="0.00"
                      className="pl-7 premium-input text-white/80 rounded-xl"
                      data-testid="input-min-amount"
                    />
                  </div>
                </div>
              )}
              {minPurchaseType === "min_quantity" && (
                <div className="mt-3">
                  <Input
                    type="number"
                    value={minQuantity}
                    onChange={e => setMinQuantity(e.target.value)}
                    placeholder="1"
                    className="max-w-xs premium-input text-white/80 rounded-xl"
                    data-testid="input-min-quantity"
                  />
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="premium-card border-white/[0.06]">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-white/80">Maximum discount uses</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={limitTotalUses}
                  onCheckedChange={v => setLimitTotalUses(!!v)}
                  data-testid="checkbox-limit-total"
                />
                <span className="text-sm text-white/70">Limit number of times this discount can be used in total</span>
              </label>
              {limitTotalUses && (
                <Input
                  type="number"
                  value={maxTotalUses}
                  onChange={e => setMaxTotalUses(e.target.value)}
                  placeholder="100"
                  className="max-w-xs premium-input text-white/80 rounded-xl ml-6"
                  data-testid="input-max-uses"
                />
              )}
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={onePerCustomer}
                  onCheckedChange={v => setOnePerCustomer(!!v)}
                  data-testid="checkbox-one-per-customer"
                />
                <span className="text-sm text-white/70">Limit to one use per customer</span>
              </label>
            </CardContent>
          </Card>

          <Card className="premium-card border-white/[0.06]">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-white/80">Combinations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={combinesWithProduct}
                  onCheckedChange={v => setCombinesWithProduct(!!v)}
                  data-testid="checkbox-combines-product"
                />
                <span className="text-sm text-white/70">Product discounts</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={combinesWithOrder}
                  onCheckedChange={v => setCombinesWithOrder(!!v)}
                  data-testid="checkbox-combines-order"
                />
                <span className="text-sm text-white/70">Order discounts</span>
              </label>
            </CardContent>
          </Card>

          <Card className="premium-card border-white/[0.06]">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-white/80">Active dates</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-white/50 text-xs font-medium mb-1.5 block">Start date</Label>
                  <DatePickerInput
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    className="premium-input text-white/80 rounded-xl"
                    data-testid="input-start-date"
                  />
                </div>
                <div>
                  <Label className="text-white/50 text-xs font-medium mb-1.5 block">Start time (NZDT)</Label>
                  <TimePickerInput
                    value={startTime}
                    onChange={e => setStartTime(e.target.value)}
                    className="premium-input text-white/80 rounded-xl"
                    data-testid="input-start-time"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={hasEndDate}
                  onCheckedChange={v => setHasEndDate(!!v)}
                  data-testid="checkbox-end-date"
                />
                <span className="text-sm text-white/70">Set end date</span>
              </label>
              {hasEndDate && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-white/50 text-xs font-medium mb-1.5 block">End date</Label>
                    <DatePickerInput
                      value={endDate}
                      onChange={e => setEndDate(e.target.value)}
                      className="premium-input text-white/80 rounded-xl"
                      data-testid="input-end-date"
                    />
                  </div>
                  <div>
                    <Label className="text-white/50 text-xs font-medium mb-1.5 block">End time (NZDT)</Label>
                    <TimePickerInput
                      value={endTime}
                      onChange={e => setEndTime(e.target.value)}
                      className="premium-input text-white/80 rounded-xl"
                      data-testid="input-end-time"
                    />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {editId && (
            <Card className="premium-card border-white/[0.06]">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-white/80">Status</CardTitle>
              </CardHeader>
              <CardContent>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="max-w-xs premium-input text-white/80 rounded-xl" data-testid="select-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="disabled">Disabled</SelectItem>
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card className="premium-card border-white/[0.06] sticky top-6">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-white/80">
                  {method === "code" ? (code || "No code yet") : "Automatic"}
                </span>
                {code && method === "code" && (
                  <button
                    onClick={() => { navigator.clipboard.writeText(code); toast({ title: "Copied!" }); }}
                    className="text-white/30 hover:text-white/50"
                    data-testid="button-copy-code"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-xs text-white/40 font-medium">Type</p>
                <p className="text-sm text-white/70">{typeInfo[discountType]?.label}</p>
                {discountType !== "free_shipping" && (
                  <p className="text-xs text-white/40 mt-0.5">
                    {method === "code" ? "Code" : "Automatic"} discount
                  </p>
                )}
              </div>

              <Separator className="bg-white/[0.06]" />

              <div>
                <p className="text-xs text-white/40 font-medium mb-1">Details</p>
                <ul className="space-y-1">
                  {summaryItems.map((item, i) => (
                    <li key={i} className="text-xs text-white/50 flex items-start gap-1.5">
                      <span className="text-white/20 mt-0.5">•</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              {editId && existingDiscount && (
                <>
                  <Separator className="bg-white/[0.06]" />
                  <div>
                    <p className="text-xs text-white/40 font-medium mb-1">Performance</p>
                    <p className="text-xs text-white/50" data-testid="text-performance-used">
                      {existingDiscount.timesUsed} used
                    </p>
                    {existingDiscount.totalDiscountedCents > 0 && (
                      <p className="text-xs text-white/50">
                        {formatCurrency(existingDiscount.totalDiscountedCents, { fromCents: true })} total discounted
                      </p>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Button
            variant="outline"
            className="w-full border-white/10 text-white/40 hover:text-white/60 rounded-xl"
            onClick={() => setShowTypeSelector(true)}
            data-testid="button-change-type"
          >
            Change discount type
          </Button>
        </div>
      </div>

      <Dialog open={showTypeSelector} onOpenChange={setShowTypeSelector}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Choose discount type</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 mt-2">
            {(Object.keys(typeInfo) as DiscountType[]).map(key => (
              <button
                key={key}
                onClick={() => {
                  setDiscountType(key);
                  setShowTypeSelector(false);
                  if (key === "free_shipping") {
                    setValueType("percentage");
                    setValue("100");
                  }
                }}
                className={`w-full text-left p-3 rounded-lg border transition-colors ${
                  discountType === key
                    ? "border-blue-500/50 bg-blue-500/10"
                    : "border-white/10 hover:bg-white/[0.02]"
                }`}
                data-testid={`type-option-${key}`}
              >
                <p className="text-sm font-medium">{typeInfo[key].label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{typeInfo[key].description}</p>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
