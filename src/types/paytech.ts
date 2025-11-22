
export interface CustomField {
    ref_command: string;
    redirect_after_success?: string;
}

export interface PayTechNotification {
    type_event: 'sale_complete' | 'sale_canceled';
    client_phone: string;
    payment_method: string;
    item_name: string;
    item_price: string;
    ref_command: string;
    command_name: string;
    currency: string;
    env: 'test' | 'prod';
    custom_field: string | CustomField;
    token: string;
    api_key_sha256: string;
    api_secret_sha256: string;
}